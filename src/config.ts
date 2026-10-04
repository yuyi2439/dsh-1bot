// 通用配置：schema（loader 校验用）、由它推导的 `OnebotConfig`、随包默认值，
// 以及每聊天工作区路径。`Config` 是通用字段的唯一定义处，`OnebotConfig` 由它
// 推导。平台相关字段（连接地址、白名单）由各 adapter 自己声明，见 adapter/。
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { AdaptersSchema, type AdapterEntry } from "./adapter/index.ts";
import { qqAdapter } from "./adapter/qq.ts";

/**
 * 默认的每聊天工作区根。必须与启动目录无关：同一个会话在别处启动 `dsh` 后
 * 若换到另一个 cwd，session store 会以 persisted-vs-live cwd 冲突拒绝该 id。
 */
export function defaultWorkspaceRoot(): string {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "workspaces", "onebot");
}

/** 在配置的根下推导某个聊天的工作区目录。 */
export function chatWorkspace(workspaceRoot: string, sessionId: string): string {
	return join(workspaceRoot, "chats", sessionId);
}

/** 随包默认值，供 schema 与种子模板共用。`workspace_root` 用 getter 延迟求值。 */
export const DEFAULTS = Object.freeze({
	enabled: false,
	access_token: "",
	prefix: "",
	connect_retries: 5,
	connect_retry_delay_secs: 1,
	reply_chunk_size: 4000,
	reply_chunk_delay_ms: 300,
	console_log: true,
	/** 日志时间戳用本机时区（带偏移）而不是 UTC（带 `Z`）。 */
	log_local_time: true,
	/** 每聊天工作区根；由 `$DSH_HOME` 推导。 */
	get workspace_root(): string {
		return defaultWorkspaceRoot();
	},
	/** 默认启用一个 adapter（具体是哪种见 adapter/ 的实现表）。 */
	get adapters(): AdapterEntry[] {
		return [{ type: qqAdapter.type, config: { ...qqAdapter.defaults } }];
	},
});

/** 插件配置 schema。必须从入口（index.ts）导出：loader 从那里读它。 */
export const Config = z.object({
	/** 是否随 profile 启动 OneBot 桥接。 */
	enabled: z.boolean().default(DEFAULTS.enabled),
	/** 访问令牌，作为 `access_token` 查询参数附加到连接地址（可选）。 */
	access_token: z.string().default(DEFAULTS.access_token),
	/** 可选前缀：只处理以它开头的消息，并在文本进入 agent 前剥掉。群聊建议设置，
	 * 否则白名单内每条消息都会跑一个完整 agent 回合。 */
	prefix: z.string().default(DEFAULTS.prefix),
	/** 要接入的 adapter 列表；`type` 必须是 adapter/ 实现表里的类型。 */
	adapters: AdaptersSchema.default(DEFAULTS.adapters),
	/** 每聊天工作区根；每个聊天会话使用 `<workspace_root>/chats/<sessionId>`。 */
	workspace_root: z.string().default(DEFAULTS.workspace_root),
	/** 首次连接失败后的重试次数；始终不可达时进程会带指引退出。 */
	connect_retries: z.number().default(DEFAULTS.connect_retries),
	/** 启动时连接重试的间隔，秒。 */
	connect_retry_delay_secs: z.number().default(DEFAULTS.connect_retry_delay_secs),
	/** 单条出站消息的字符上限（超过即分块）。 */
	reply_chunk_size: z.number().default(DEFAULTS.reply_chunk_size),
	/** 同一条回复相邻分块的间隔，毫秒 —— 避免多分块连发触发风控。 */
	reply_chunk_delay_ms: z.number().default(DEFAULTS.reply_chunk_delay_ms),
	/** 把 `onebot` logger 打到进程控制台；dsh-base 自己不挂控制台 exporter。 */
	console_log: z.boolean().default(DEFAULTS.console_log),
	/** 日志时间戳用本机时区（带偏移）还是 UTC（带 `Z`）。 */
	log_local_time: z.boolean().default(DEFAULTS.log_local_time),
});

/** 解析后的插件配置；由 schema 推导，每个字段都有默认值所以总是完整的。 */
export type OnebotConfig = ReturnType<typeof Config>;
