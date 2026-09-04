// dsh-1bot plugin entry: OneBot 11 as a dsh UI surface (profile bundle over
// dsh-base, on par with web/tui). Mounts the WS client, the chat ⇄ agent
// bridge, the OneBot tools (onebot_* family), and the QQ in-chat approval
// answerer, and exposes the `ctx.onebot` service for other plugins (e.g. a
// persona-layer plugin).
import type { Context, Message } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { OneBotClient } from "./client.ts";
import { OneBotBridge, defaultWorkspaceRoot } from "./bridge.ts";
import { ensureHiddenSessionsDocs, hiddenSessionsRoot } from "./hidden-sessions.ts";
import { seedProfilePatch, profilePatchPath } from "./profile-setup.ts";
import { acquireSingletonLock } from "./singleton.ts";
import { registerOneBotTools } from "./tools.ts";
import type { OnebotConfig, OnebotService } from "./types.ts";

declare module "@deepseek-ai/cordis" {
	interface Context {
		/** The active OneBot service, provided while the plugin is enabled. */
		onebot: OnebotService;
	}
}

/** Cordis plugin name used by loader diagnostics. */
export const name = "onebot";

/** Core services required before the bridge can drive agents. */
export const inject: string[] = ["tools", "agents", "sessions", "agentDefaultModel"];

/** Plugin configuration (all fields optional; defaults are the shipped caps). */
export const Config: z<OnebotConfig> = z.object({
	/** Whether to start the OneBot bridge with the profile. */
	enabled: z.boolean().default(false),
	/** Connection mode; only `"ws"` (forward WebSocket) is implemented. */
	mode: z.string().default("ws"),
	/** Forward WebSocket URL of the OneBot implementation (NapCat default). */
	ws_url: z.string().default("ws://127.0.0.1:3001"),
	/** Access token sent as `Authorization: Bearer <token>` (optional). */
	access_token: z.string().default(""),
	/** Optional prefix: only messages starting with it are answered; it is
	 * stripped before the text reaches the agent. */
	prefix: z.string().default(""),
	/** Allowlisted friend QQ ids (private chats). Empty list = nobody. */
	friend_ids: z.array(z.number()).default([]),
	/** Allowlisted group ids. Empty list = no group. */
	group_ids: z.array(z.number()).default([]),
	/** Root for per-chat workspaces; each chat session gets
	 * `<workspace_root>/chats/<sessionId>` (default: `$DSH_HOME/workspaces/onebot`). */
	workspace_root: z.string(),
	/** Startup connect retries after the first attempt; the process exits with
	 * guidance when the server stays unreachable. */
	connect_retries: z.number().default(5),
	/** Delay between startup connect attempts (seconds). */
	connect_retry_delay_secs: z.number().default(1),
	/** Max characters per outbound QQ message (chunked above this). */
	reply_chunk_size: z.number().default(4000),
	/** Seconds a QQ in-chat approval waits before settling `cancelled`. */
	approval_timeout_secs: z.number().default(300),
	/**
	 * Print the `onebot` logger to the process console. dsh-base mounts no
	 * console exporter (logs only enter the in-memory buffer), so without
	 * this the profile runs silent; keep it on unless embedding the plugin
	 * in a profile that already surfaces logs (e.g. web).
	 */
	console_log: z.boolean().default(true),
});

/** Render one structured log message as a plain console line. */
function formatLogLine(message: Message): string {
	const time = new Date(message.ts).toISOString().replace("T", " ").slice(0, 19);
	const args = message.args
		.map((arg) => {
			if (typeof arg === "string") return arg;
			try {
				return JSON.stringify(arg);
			} catch {
				return String(arg);
			}
		})
		.join(" ");
	return `[${message.name} ${message.type}] ${time} ${args}`;
}

/**
 * Mount the OneBot UI surface. No-op unless `enabled` and `mode === "ws"`.
 */
export async function apply(ctx: Context, config: OnebotConfig): Promise<void> {
	if (!config.enabled) return;
	if (config.mode !== "ws") {
		ctx.logger?.("onebot").warn?.(`onebot: unsupported mode '${config.mode}', only 'ws' is implemented`);
		return;
	}
	const log = ctx.logger?.("onebot") ?? console;
	// dsh-base mounts no console exporter, so register one for the `onebot`
	// logger when the profile should be observable from the terminal.
	// `default: -1` is load-bearing: without it every other plugin's info
	// log falls through the levels filter and leaks onto the console.
	if (config.console_log && ctx.logger?.exporter) {
		ctx.logger.exporter({
			colors: 0,
			levels: { onebot: 2, default: -1 }, // only the onebot logger (error/info/warn)
			export: (message) => {
				const line = formatLogLine(message);
				(message.type === "error" ? process.stderr : process.stdout).write(line + "\n");
			},
		});
	}
	// First-run config gate: with no `- id: onebot` row in the profile patch
	// the plugin is not configured. Append the commented template, tell the
	// user what to do, and exit BEFORE connecting — this is the ONLY place
	// the config file is touched; the connect path never modifies it.
	if (await seedProfilePatch(config)) {
		log.info?.(`配置模板已写入 ${profilePatchPath()}`);
		log.info?.(
			"请编辑该文件：取消注释并按需修改（enabled / ws_url / access_token / friend_ids / group_ids …），" +
				"同时删除文件顶部的 `[]`，然后重新启动 dsh --profile onebot。",
		);
		process.exit(1);
	}
	log.info?.(
		`starting: ws_url=${config.ws_url} mode=${config.mode} ` +
			`friends=[${config.friend_ids.join(",")}] groups=[${config.group_ids.join(",")}]`,
	);
	if (config.friend_ids.length === 0 && config.group_ids.length === 0) {
		log.warn?.(
			"friend_ids and group_ids are both empty — every incoming message is ignored. " +
				"Set friend_ids/group_ids in $DSH_HOME/profiles/onebot/cordis.patch.yml " +
				"(an id-targeted patch replaces the whole onebot config; restate every field).",
		);
	}
	// Single-instance guard: two dsh processes bridging the same chats append
	// to the same persisted sessions with independent seq counters, which
	// corrupts the logs. Refuse to start when another live instance holds the
	// lock, instead of silently corrupting shared sessions.
	const workspaceRoot = config.workspace_root ?? defaultWorkspaceRoot();
	const releaseLock = await acquireSingletonLock(join(workspaceRoot, ".onebot.lock"));
	if (!releaseLock) {
		log.error?.(
			`another dsh-1bot instance is already running (lock held at ${join(workspaceRoot, ".onebot.lock")}) — ` +
				"refusing to start; stop the other instance first (two instances corrupt the shared chat sessions)",
		);
		return;
	}
	// Create the hidden sessions root (where session-persistence-jsonl stores
	// these sessions) together with its explanatory README, so anyone opening
	// the directory understands why it exists outside the web-scanned root.
	await ensureHiddenSessionsDocs(hiddenSessionsRoot());
	const client = new OneBotClient({
		wsUrl: config.ws_url,
		accessToken: config.access_token,
		log,
	});
	const bridge = new OneBotBridge({
		ctx,
		config,
		client,
		log,
		agents: ctx.get("agents")!,
		sessions: ctx.get("sessions")!,
		agentDefaultModel: ctx.get("agentDefaultModel"),
	});

	client.onMessage((event) => {
		bridge.onMessageEvent(event).catch((err) => {
			log.warn?.(`onebot: event handling failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	});
	registerOneBotTools(ctx, bridge);
	// dsh-1bot is an ADAPTER only: no prompt/persona injection here (that
	// belongs to a separate persona-layer plugin). The onebot_send tool's own
	// description carries the reply contract ("this is the only way to
	// deliver any message — call it to reply in the current chat").
	ctx.provide("onebot", bridge.publicService());
	// Connect with bounded startup retries. An unreachable server is fatal —
	// log clear guidance and exit — but this path NEVER touches the config
	// file (the first-run config gate above is the only writer).
	try {
		await client.start({
			retries: config.connect_retries,
			retryDelayMs: (config.connect_retry_delay_secs ?? 1) * 1000,
		});
	} catch (err) {
		log.error?.(`${err instanceof Error ? err.message : String(err)}`);
		log.error?.(
			"OneBot 服务器连不上 —— 请检查 $DSH_HOME/profiles/onebot/cordis.patch.yml 中的 ws_url / access_token：" +
				"NapCat 是否在运行、正向 WS 是否开启、地址/令牌是否正确，然后重新启动。",
		);
		process.exit(1);
	}
	// Tear down on plugin unload (e.g. HMR): stop the socket loop, dispose
	// every chat agent and pending approval, and release the singleton lock.
	ctx.effect(
		() => async () => {
			client.stop();
			bridge.dispose();
			await releaseLock();
		},
		"onebot: teardown",
	);
}
