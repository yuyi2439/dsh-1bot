// OneBot ⇄ dsh agent bridge (ported from nota-onebot crates/nota-onebot/src/
// bridge.rs, adapted to the dsh agent/session model). OneBot is a UI surface
// on par with web/tui: each QQ chat (private/group) maps to one dsh agent +
// session; inbound messages drive turns; the final assistant text is routed
// back to the originating chat. The bridge owns the allowlist, the QQ in-chat
// approval round-trip (同意/拒绝), and reply chunking.
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type { OneBotLog } from "./client.ts";
import { OneBotClient } from "./client.ts";
import type { ChatRoute, OneBotMessageEvent, OneBotPostEvent } from "./protocol.ts";
import {
	chunkText,
	identity,
	isMessageEvent,
	parseApproval,
	parseTarget,
	sendGroupMsg,
	sendPrivateMsg,
	toText,
	toTextWithId,
} from "./protocol.ts";
import type { BridgeServices, OnebotConfig, OnebotService } from "./types.ts";

/** Default max characters per outbound QQ message. */
const MAX_MESSAGE_CHARS = 4000;

/** Map a OneBot session id back to its reply route. */
export function sessionToRoute(sessionId: string): ChatRoute | null {
	const m = /^onebot:(private|group):(\d+)$/.exec(String(sessionId ?? ""));
	if (!m) return null;
	return m[1] === "private"
		? { kind: "private", user_id: Number(m[2]) }
		: { kind: "group", group_id: Number(m[2]) };
}

/** Session id + identity prefix for an inbound message event. */
function routeForMessage(msg: OneBotMessageEvent): { sessionId: string; prefix: string } | null {
	if (msg.message_type === "private") {
		return {
			sessionId: `onebot:private:${msg.user_id}`,
			prefix: `[好友 ${identity(msg.sender, msg.user_id)}] `,
		};
	}
	if (msg.message_type === "group" && msg.group_id != null) {
		return {
			sessionId: `onebot:group:${msg.group_id}`,
			prefix: `[群 ${msg.group_id} ${identity(msg.sender, msg.user_id)}] `,
		};
	}
	return null;
}

/** The last non-empty assistant text in the owned event interval. */
function summarizeReply(events: readonly SessionEvent[], firstSeq: number): string {
	let started = false;
	let text = "";
	for (const event of events) {
		if (event.seq < firstSeq) continue;
		if (event.type === "turn/start") {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === "assistant/message") {
			const content = (event.data as { message: { content: Array<{ type: string; text?: string }> } }).message.content;
			const joined = content
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("");
			if (joined !== "") text = joined;
		}
	}
	return text;
}

/** One pending QQ approval, FIFO per session. */
interface PendingApprovalEntry {
	resolve: (outcome: ApprovalOutcome) => void;
	timer?: NodeJS.Timeout;
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
	private readonly approval?: BridgeServices["approval"];
	/** sessionId -> { agent, dispose } */
	private readonly agentHandles = new Map<string, AgentHandle>();
	/** sessionId -> tail Promise; serializes turns per chat. */
	private readonly turnChains = new Map<string, Promise<void>>();
	/** sessionId -> pending approval entries, FIFO. */
	private readonly pendingApprovals = new Map<string, PendingApprovalEntry[]>();
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
		approval,
	}: {
		ctx: Context;
		config: OnebotConfig;
		client: OneBotClient;
		log?: OneBotLog;
		agents: BridgeServices["agents"];
		sessions: BridgeServices["sessions"];
		agentDefaultModel?: BridgeServices["agentDefaultModel"];
		approval?: BridgeServices["approval"];
	}) {
		this.ctx = ctx;
		this.config = config;
		this.client = client;
		this.log = log ?? console;
		this.agents = agents;
		this.sessions = sessions;
		this.agentDefaultModel = agentDefaultModel;
		this.approval = approval;
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

			// Approve / deny commands for pending approvals are handled here
			// and never reach the agent.
			const raw = toText(msg.message);
			const approval = parseApproval(raw);
			if (approval) {
				const route = routeForMessage(msg);
				if (route) {
					this.log.info?.(`approval command (${approval.approved ? "同意" : "拒绝"}) for ${route.sessionId}`);
					this.resolveApproval(route.sessionId, approval);
				}
				return;
			}

			// Non-text segments render as `[{type} msg id:<id>]`; the persona
			// fetches their content with a tool when needed.
			let text = toTextWithId(msg.message, String(msg.message_id ?? ""));
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
	 * sequentially (one in-flight agent turn at a time, like nota's
	 * per-session loop); a failing turn is logged and never breaks the chain.
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

	/** Drive one full turn: followup → quiescence → flush → reply. */
	private async runTurn(sessionId: string, text: string): Promise<void> {
		if (this.disposed) return;
		const { agent } = await this.ensureAgent(sessionId);
		await agent.whenIdle();
		const firstSeq = agent.session.seq;
		agent.followup(
			createUserMessage({
				content: [{ type: "text", text }],
				source: { kind: "user" },
			}),
		);
		await agent.whenIdle();
		await this.sessions.flush(agent.session);
		const reply = summarizeReply(agent.session.events, firstSeq);
		if (!reply) return;
		const route = sessionToRoute(sessionId);
		if (route) this.sendReply(route, reply);
	}

	/**
	 * Get (or create) the agent for a chat session. Creation mirrors
	 * `dsh-headless`: default model selection + per-agent model install.
	 */
	private async ensureAgent(sessionId: string): Promise<AgentHandle> {
		const existing = this.agentHandles.get(sessionId);
		if (existing) return existing;
		const selection = this.agentDefaultModel?.currentSelection();
		const handle = await this.agents.create({
			sessionId: SessionId(sessionId),
			meta: { cwd: this.config.cwd ?? process.cwd() },
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
			const action =
				route.kind === "private"
					? sendPrivateMsg(route.user_id, chunk)
					: sendGroupMsg(route.group_id, chunk);
			this.client.sendAction(action);
		}
	}

	/** Send to a target; throws when the target is invalid or not allowlisted. */
	sendTarget(target: string, text: string): void {
		const route = parseTarget(target);
		if (!route) throw new Error(`invalid target: ${target}`);
		if (!this.isAllowedRoute(route)) throw new Error(`target ${target} is not in the allowlist`);
		this.sendReply(route, text);
	}

	/** Send to a target, bypassing the allowlist (the user already approved). */
	sendTargetApproved(target: string, text: string): void {
		const route = parseTarget(target);
		if (!route) throw new Error(`invalid target: ${target}`);
		this.sendReply(route, text);
	}

	/**
	 * Route a tool's permission question through the approval seam. Fails
	 * closed to `'unavailable'` when no approval service is mounted.
	 */
	requestApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
		if (!this.approval) return Promise.resolve("unavailable");
		return this.approval.request(req);
	}

	// ── approvals over QQ ─────────────────────────────────────────────────

	/**
	 * Register the `approval/request` waterfall answerer. It claims only
	 * requests whose agent session belongs to OneBot; everything else is
	 * delegated with `next()`.
	 */
	registerApprovalAnswerer(): void {
		this.ctx.on("approval/request", (req, next) => this.answerApproval(req, next));
	}

	private answerApproval(req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
		const route = sessionToRoute(req.agent.session.id);
		if (!route) return next();
		if (this.disposed || !this.client.isConnected()) return Promise.resolve("unavailable");
		return new Promise<ApprovalOutcome>((resolve) => {
			const queue = this.pendingApprovals.get(req.agent.session.id) ?? [];
			const entry: PendingApprovalEntry = { resolve };
			queue.push(entry);
			this.pendingApprovals.set(req.agent.session.id, queue);
			const seq = queue.length;
			const notice =
				seq === 1
					? `需要你授权：${req.reason ?? req.toolName}\n回复「同意」批准，或「拒绝」拒绝\n（工具：${req.toolName}）`
					: `需要你授权：${req.reason ?? req.toolName}\n这是第 ${seq} 个待处理请求，回复「同意${seq}」或「拒绝${seq}」\n（工具：${req.toolName}）`;
			this.sendReply(route, notice);

			const settle = (outcome: ApprovalOutcome): void => {
				clearTimeout(entry.timer);
				this.removeApproval(req.agent.session.id, entry);
				resolve(outcome);
			};
			entry.timer = setTimeout(
				() => settle("cancelled"),
				(this.config.approval_timeout_secs ?? 300) * 1000,
			);
			if (req.signal) {
				if (req.signal.aborted) {
					settle("cancelled");
					return;
				}
				req.signal.addEventListener("abort", () => settle("cancelled"), { once: true });
			}
		});
	}

	/** Remove a specific entry from a session's pending queue. */
	private removeApproval(sessionId: string, entry: PendingApprovalEntry): void {
		const queue = this.pendingApprovals.get(sessionId);
		if (!queue) return;
		const index = queue.indexOf(entry);
		if (index !== -1) queue.splice(index, 1);
		if (queue.length === 0) this.pendingApprovals.delete(sessionId);
	}

	/** Resolve the pending approval addressed by an in-chat 同意/拒绝 command. */
	resolveApproval(sessionId: string, { approved, seq }: { approved: boolean; seq: number | null }): void {
		const queue = this.pendingApprovals.get(sessionId);
		if (!queue?.length) return;
		const index = seq == null || seq === 1 ? 0 : seq - 1;
		if (index < 0 || index >= queue.length) return;
		const [entry] = queue.splice(index, 1);
		if (queue.length === 0) this.pendingApprovals.delete(sessionId);
		clearTimeout(entry.timer);
		entry.resolve(approved ? "allowed-once" : "rejected");
	}

	// ── service surface / teardown ────────────────────────────────────────

	/** The `ctx.onebot` service value exposed for other plugins (dsh-nota). */
	publicService(): OnebotService {
		return {
			client: this.client,
			isAllowedTarget: (target) => this.isAllowedTarget(target),
			send: (target, text) => this.sendTarget(target, text),
			sendApproved: (target, text) => this.sendTargetApproved(target, text),
			sendReply: (route, text) => this.sendReply(route, text),
		};
	}

	/** Stop accepting work, settle pending approvals, dispose every agent. */
	dispose(): void {
		this.disposed = true;
		for (const handle of this.agentHandles.values()) {
			handle.dispose().catch(() => {});
		}
		this.agentHandles.clear();
		for (const queue of this.pendingApprovals.values()) {
			for (const entry of queue) {
				clearTimeout(entry.timer);
				entry.resolve("cancelled");
			}
		}
		this.pendingApprovals.clear();
	}
}
