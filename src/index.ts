// dsh-1bot 插件入口：把 OneBot 11 变成 dsh 的一个 UI 表面。挂载 WS 客户端、
// 聊天 ⇄ agent 桥接层与 onebot_* 工具，并暴露 `ctx.onebot` 服务给其他插件。
import type { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { connect, type OneBotClient } from "onebot.js";
import { OneBotBridge } from "./bridge.ts";
import { allowlistForKind, enabledAdapters, enabledRouteKinds, transportUrl } from "./adapter/index.ts";
import { Config, type OnebotConfig } from "./config.ts";
import { formatConnectFailure, probeForwardWsPort } from "./connect-error.ts";
import { mountConsoleExporter } from "./log.ts";
import type { OneBotPostEvent } from "./protocol.ts";
import { seedProfilePatch, profilePatchPath } from "./profile-setup.ts";
import { ensureHiddenSessionsDocs, hiddenSessionsRoot } from "./session.ts";
import { acquireSingletonLock } from "./singleton.ts";
import { registerOneBotTools } from "./tools.ts";
import { publicService, type OnebotService } from "./service.ts";

declare module "@deepseek-ai/cordis" {
	interface Context {
		/** 插件启用期间提供的活动 OneBot 服务。 */
		onebot: OnebotService;
	}
}

/** 供 loader 诊断使用的 cordis 插件名。 */
export const name = "onebot";

/** 桥接层驱动 agent 之前必须就绪的核心服务。 */
export const inject: string[] = ["tools", "agents", "sessions", "sessionPersistence", "agentDefaultModel"];

/** 插件配置 schema（loader 从入口读取这个导出）。 */
export { Config };

/** 挂载 OneBot UI 表面。`enabled` 为假时不做任何事。 */
export async function apply(ctx: Context, config: OnebotConfig): Promise<void> {
	if (!config.enabled) return;
	// logger 是 cordis 内建服务，任何 ctx 都有它。
	const logger = ctx.logger("onebot");
	if (config.console_log) {
		mountConsoleExporter(ctx.logger, config.log_local_time);
	}
	// 首次运行配置门：patch 里没有 `- id: onebot` 行时种下模板并退出。这是唯一
	// 写配置文件的地方。
	if (await seedProfilePatch(config)) {
		logger.info(`配置模板已写入 ${profilePatchPath()}`);
		logger.info(
			"请编辑该文件：取消注释并按需修改，同时删除文件顶部的 `[]`，" +
				"然后重新启动 dsh --profile onebot。",
		);
		process.exit(1);
	}
	// 连接地址由 adapter 自己的配置提供。
	const url = transportUrl(config);
	if (!url) {
		logger.error(
			"no enabled adapter declares a connection URL — nothing to connect to. " +
				"Enable an adapter (with its connection settings) in $DSH_HOME/profiles/onebot/cordis.patch.yml " +
				"(an id-targeted patch replaces the whole onebot config; restate every field).",
		);
		return;
	}
	const adapters = enabledAdapters(config);
	logger.info(`starting: url=${url} adapters=[${adapters.map((a) => a.adapter.type).join(",")}]`);
	for (const { adapter } of adapters) {
		const lists = Object.keys(adapter.routes).map((kind) => `${kind}=[${allowlistForKind(config, kind).join(",")}]`);
		logger.info(`  ${adapter.type}: ${lists.join(" ")}`);
	}
	// 没有启用任何 adapter，或所有白名单都为空 = 没有消息会被处理。
	const kinds = enabledRouteKinds(config);
	if (kinds.length === 0) {
		logger.warn(
			"no adapter is enabled — every incoming message is ignored. " +
				"Configure `adapters` in $DSH_HOME/profiles/onebot/cordis.patch.yml " +
				"(an id-targeted patch replaces the whole onebot config; restate every field).",
		);
	} else if (kinds.every((kind) => allowlistForKind(config, kind).length === 0)) {
		logger.warn(
			`every allowlist is empty (${kinds.join(", ")}) — every incoming message is ignored. ` +
				"Configure the adapters' allowlists in $DSH_HOME/profiles/onebot/cordis.patch.yml " +
				"(an id-targeted patch replaces the whole onebot config; restate every field).",
		);
	}
	// 单实例守卫：两个进程桥接同样的聊天会各自独立计数 seq，写坏同一份日志。
	const workspaceRoot = config.workspace_root;
	const lockPath = join(workspaceRoot, ".onebot.lock");
	const releaseLock = await acquireSingletonLock(lockPath);
	if (!releaseLock) {
		logger.error(
			`another dsh-1bot instance is already running (lock held at ${lockPath}) — ` +
				"refusing to start; stop the other instance first (two instances corrupt the shared chat sessions)",
		);
		return;
	}
	await ensureHiddenSessionsDocs(hiddenSessionsRoot());
	// connect() 只在连接建立后 resolve；重试预算耗尽时抛出，下面按致命错误处理。
	let client: OneBotClient;
	try {
		client = await connect({
			baseUrl: url,
			accessToken: config.access_token,
			logger,
			reconnection: {
				enable: true,
				attempts: config.connect_retries + 1,
				delay: (config.connect_retry_delay_secs ?? 1) * 1000,
			},
		});
	} catch (err) {
		logger.error(
			formatConnectFailure(
				{
					wsUrl: url,
					hasAccessToken: config.access_token !== "",
					cause: err instanceof Error ? err.message : String(err),
					attempts: config.connect_retries + 1,
					delaySecs: config.connect_retry_delay_secs ?? 1,
					patchPath: profilePatchPath(),
				},
				await probeForwardWsPort(url),
			),
		);
		process.exit(1);
	}
	const bridge = new OneBotBridge(ctx, config, client);

	client.on("message", (event) => {
		bridge.onMessageEvent(event as unknown as OneBotPostEvent).catch((err) => {
			logger.warn(`event handling failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	});
	registerOneBotTools(ctx, bridge);
	ctx.provide("onebot", publicService(bridge));
	// 插件卸载（如 HMR）时清理；agent 由 cordis 随创建它的 fiber 一起释放。
	ctx.effect(
		() => async () => {
			client.disconnect();
			await releaseLock();
		},
		"onebot: teardown",
	);
}
