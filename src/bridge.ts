// OneBot ⇄ dsh agent bridge (ported from the nota project's Rust OneBot
// bridge, adapted to the dsh agent/session model). OneBot is a UI surface
// on par with web/tui: each QQ chat (private/group) maps to one dsh agent +
// session; inbound messages drive turns. The bridge owns the allowlist and
// reply chunking; sending is ALWAYS explicit via the onebot_send tool (each
// call delivers immediately, so the model can answer, research, then answer
// again in one turn). There is no reply slot and no auto-send.
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { type OneBotClient, type OneBotLog } from "onebot.js";
import type { ChatRoute, OneBotMessageEvent, OneBotPostEvent } from "./protocol.ts";
import { chunkText, identity, isMessageEvent, messageToText, parseTarget } from "./protocol.ts";
import type { BridgeServices, OnebotConfig, OnebotService } from "./types.ts";

/** Default max characters per outbound QQ message. */
const MAX_MESSAGE_CHARS = 4000;

/**
 * The default per-chat workspace root. STABLE on purpose: it must not depend
 * on the launch directory, or the same chat session would be persisted at a
 * different cwd after `dsh` starts elsewhere and the session store rejects
 * the id (persisted-vs-live cwd collision).
 */
export function defaultWorkspaceRoot(): string {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "workspaces", "onebot");
}

/** Derive one chat's workspace folder under the configured root. */
export function chatWorkspace(workspaceRoot: string, sessionId: string): string {
	return join(workspaceRoot, "chats", sessionId);
}

/**
 * Map a OneBot session id back to its reply route. The id deliberately uses
 * `-` separators (`onebot-private-<QQ>` / `onebot-group-<群号>`) so the JSONL
 * backend stores it verbatim — `:` would be escaped to `~003A` on disk.
 */
export function sessionToRoute(sessionId: string): ChatRoute | null {
	const m = /^onebot-(private|group)-(\d+)$/.exec(String(sessionId ?? ""));
	if (!m) return null;
	return m[1] === "private"
		? { kind: "private", user_id: Number(m[2]) }
		: { kind: "group", group_id: Number(m[2]) };
}

/** Session id + identity prefix for an inbound message event. */
function routeForMessage(msg: OneBotMessageEvent): { sessionId: string; prefix: string } | null {
	if (msg.message_type === "private") {
		return {
			sessionId: `onebot-private-${msg.user_id}`,
			prefix: `[好友 ${identity(msg.sender, msg.user_id)}] `,
		};
	}
	if (msg.message_type === "group" && msg.group_id != null) {
		return {
			sessionId: `onebot-group-${msg.group_id}`,
			prefix: `[群 ${msg.group_id} ${identity(msg.sender, msg.user_id)}] `,
		};
	}
	return null;
}

/**
 * OneBot chat ⇄ dsh agent bridge. Constructed by the plugin entry with the
 * resolved services; the client is started and disposed by the entry too.
 */
export class OneBotBridge {
	private readonly ctx: Context;
	readonly config: OnebotConfig;
	readonly client: OneBotClient;
	private readonly log: OneBotLog;
	private readonly agents: BridgeServices["agents"];
	private readonly sessions: BridgeServices["sessions"];
	private readonly agentDefaultModel?: BridgeServices["agentDefaultModel"];
	/** sessionId -> { agent, dispose } */
	private readonly agentHandles = new Map<string, AgentHandle>();
	/** sessionId -> tail Promise; serializes turns per chat. */
	private readonly turnChains = new Map<string, Promise<void>>();
	private disposed = false;
	/** Correlated action API, exposed for the tools (`bridge.api`). */
	readonly api: OneBotClient;

	constructor({
		ctx,
		config,
		client,
		log,
		agents,
		sessions,
		agentDefaultModel,
	}: {
		ctx: Context;
		config: OnebotConfig;
		client: OneBotClient;
		log?: OneBotLog;
		agents: BridgeServices["agents"];
		sessions: BridgeServices["sessions"];
		agentDefaultModel?: BridgeServices["agentDefaultModel"];
	}) {
		this.ctx = ctx;
		this.config = config;
		this.client = client;
		this.log = log ?? console;
		this.agents = agents;
		this.sessions = sessions;
		this.agentDefaultModel = agentDefaultModel;
		this.api = client;
	}

	// ── inbound ───────────────────────────────────────────────────────────

	/**
	 * Handle one OneBot post event (called from the client's message
	 * handler). Only `message` events are acted on; everything else is
	 * ignored. Never rejects.
	 */
	async onMessageEvent(event: OneBotPostEvent): Promise<void> {
		try {
			if (this.disposed || !isMessageEvent(event)) return;
			const msg: OneBotMessageEvent = event;
			// Never answer our own messages.
			if (msg.user_id === msg.self_id) {
				this.log.info?.(`ignored own message (user_id=${msg.user_id})`);
				return;
			}
			// Entry gate: non-allowlisted chats never reach the agent.
			if (!this.isAllowed(msg)) {
				this.log.info?.(
					`ignored message from non-allowlisted chat (type=${msg.message_type} ` +
						`user_id=${msg.user_id}${msg.group_id != null ? ` group_id=${msg.group_id}` : ""})`,
				);
				return;
			}

			// Non-text segments render per type (default: all data as key=value
			// plus the message id); the persona fetches content with a tool.
			let text = messageToText(msg.message, String(msg.message_id ?? ""));
			if (!text.trim()) {
				this.log.info?.(`ignored empty message from ${msg.message_type}:${msg.user_id}`);
				return;
			}
			if (this.config.prefix) {
				if (!text.startsWith(this.config.prefix)) {
					this.log.info?.(`ignored message without prefix '${this.config.prefix}' from ${msg.message_type}:${msg.user_id}`);
					return;
				}
				text = text.slice(this.config.prefix.length).trimStart();
			}

			const route = routeForMessage(msg);
			if (!route) return;
			this.log.info?.(`message from ${route.sessionId}: ${text.slice(0, 200)}`);
			this.enqueueTurn(route.sessionId, route.prefix + text);
		} catch (err) {
			this.log.warn?.(`onebot: event handling failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Whether a message event comes from an allowlisted chat. */
	isAllowed(msg: OneBotMessageEvent): boolean {
		if (msg.message_type === "private") return this.config.friend_ids.includes(msg.user_id);
		if (msg.message_type === "group") return msg.group_id != null && this.config.group_ids.includes(msg.group_id);
		return false;
	}

	/** Whether a target string (`private:<QQ>` / `group:<群号>`) is allowlisted. */
	isAllowedTarget(target: string): boolean {
		const route = parseTarget(target);
		return route != null && this.isAllowedRoute(route);
	}

	private isAllowedRoute(route: ChatRoute): boolean {
		return route.kind === "private"
			? this.config.friend_ids.includes(route.user_id)
			: this.config.group_ids.includes(route.group_id);
	}

	/**
	 * Queue one turn for a chat. Turns of the same chat run strictly
	 * sequentially (one in-flight agent turn at a time); a failing turn is
	 * logged and never breaks the chain.
	 */
	enqueueTurn(sessionId: string, text: string): Promise<void> {
		const prev = this.turnChains.get(sessionId) ?? Promise.resolve();
		const run = prev.then(() => this.runTurn(sessionId, text));
		this.turnChains.set(
			sessionId,
			run.catch((err) => {
				this.log.warn?.(`onebot: turn failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
			}),
		);
		return run;
	}

	/** Drive one full turn: followup → quiescence → flush. */
	private async runTurn(sessionId: string, text: string): Promise<void> {
		if (this.disposed) return;
		const { agent } = await this.ensureAgent(sessionId);
		await agent.whenIdle();
		agent.followup(
			createUserMessage({
				content: [{ type: "text", text }],
				source: { kind: "user" },
			}),
		);
		await agent.whenIdle();
		await this.sessions.flush(agent.session);
		// NO auto-send: the bridge never delivers anything on its own. Every
		// outbound message goes through the onebot_send tool, which calls
		// sendReply immediately — so the model can reply, look things up,
		// and reply again within one turn, each call sending right away.
	}

	/**
	 * Get (or create) the agent for a chat session. Creation mirrors
	 * `dsh-headless`: default model selection + per-agent model install.
	 * Each chat gets its own dynamic workspace folder
	 * (`<workspace_root>/chats/<sessionId>`, created on first use), so files
	 * and the session's cwd stay isolated per conversation.
	 */
	private async ensureAgent(sessionId: string): Promise<AgentHandle> {
		const existing = this.agentHandles.get(sessionId);
		if (existing) return existing;
		const cwd = chatWorkspace(this.config.workspace_root ?? defaultWorkspaceRoot(), sessionId);
		await mkdir(cwd, { recursive: true });
		const selection = this.agentDefaultModel?.currentSelection();
		const handle = await this.agents.create({
			sessionId: SessionId(sessionId),
			meta: { cwd },
			agentOptions: selection ? { provider: selection.provider, model: selection.model } : {},
			setup: selection
				? (agentCtx) => {
						installModelSelection(agentCtx, { current: selection, assembled: undefined });
				  }
				: undefined,
		});
		this.agentHandles.set(sessionId, handle);
		return handle;
	}

	// ── outbound ──────────────────────────────────────────────────────────

	/** Send a reply to a route, chunked at the configured size. */
	sendReply(route: ChatRoute, text: string): void {
		const maxChars = this.config.reply_chunk_size ?? MAX_MESSAGE_CHARS;
		const target = route.kind === "private" ? `private:${route.user_id}` : `group:${route.group_id}`;
		this.log.info?.(`send to ${target}: ${text.slice(0, 200)}`);
		for (const chunk of chunkText(text, maxChars)) {
			if (route.kind === "private") {
				this.client
					.send("send_private_msg", {
						user_id: route.user_id,
						message: [{ type: "text", data: { text: chunk } }],
					})
					.catch((err) => this.log.warn?.(`onebot: ${err instanceof Error ? err.message : String(err)}`));
			} else {
				this.client
					.send("send_group_msg", {
						group_id: route.group_id,
						message: [{ type: "text", data: { text: chunk } }],
					})
					.catch((err) => this.log.warn?.(`onebot: ${err instanceof Error ? err.message : String(err)}`));
			}
		}
	}

	/** Send to a target; throws when the target is invalid or not allowlisted. */
	sendTarget(target: string, text: string): void {
		const route = parseTarget(target);
		if (!route) throw new Error(`invalid target: ${target}`);
		if (!this.isAllowedRoute(route)) throw new Error(`target ${target} is not in the allowlist`);
		this.sendReply(route, text);
	}

	// ── service surface / teardown ────────────────────────────────────────

	/** The `ctx.onebot` service value exposed for other plugins (e.g. a persona-layer plugin). */
	publicService(): OnebotService {
		return {
			client: this.client,
			isAllowedTarget: (target) => this.isAllowedTarget(target),
			send: (target, text) => this.sendTarget(target, text),
			sendReply: (route, text) => this.sendReply(route, text),
		};
	}

	/** Stop accepting work and dispose every agent. */
	dispose(): void {
		this.disposed = true;
		for (const handle of this.agentHandles.values()) {
			handle.dispose().catch(() => {});
		}
		this.agentHandles.clear();
	}
}
