// dsh-onebot plugin entry: OneBot 11 as a dsh UI surface (profile bundle over
// dsh-base, on par with web/tui). Mounts the WS client, the chat ⇄ agent
// bridge, the OneBot tools (onebot_* family), and the QQ in-chat approval
// answerer, and exposes the `ctx.onebot` service for other plugins (e.g.
// dsh-nota).
import type { Context, Message } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { OneBotClient } from "./client.ts";
import { OneBotBridge } from "./bridge.ts";
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
	/** Session workspace root for created agents (default: process.cwd()). */
	cwd: z.string(),
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
export function apply(ctx: Context, config: OnebotConfig): void {
	if (!config.enabled) return;
	if (config.mode !== "ws") {
		ctx.logger?.("onebot").warn?.(`onebot: unsupported mode '${config.mode}', only 'ws' is implemented`);
		return;
	}
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
	const log = ctx.logger?.("onebot") ?? console;
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
		approval: ctx.get("approval"),
	});

	client.onMessage((event) => {
		bridge.onMessageEvent(event).catch((err) => {
			log.warn?.(`onebot: event handling failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	});
	client.start();
	registerOneBotTools(ctx, bridge);
	bridge.registerApprovalAnswerer();
	ctx.provide("onebot", bridge.publicService());
	// Tear down on plugin unload (e.g. HMR): stop the socket loop and dispose
	// every chat agent and pending approval.
	ctx.effect(
		() => () => {
			client.stop();
			bridge.dispose();
		},
		"onebot: teardown",
	);
}
