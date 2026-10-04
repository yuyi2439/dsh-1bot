// adapter 契约：一个 adapter 就是"某种聊天平台/协议在 dsh 里的接入方式"。
//
// 它声明 `routes`（支持的路由种类及其全部接线方式）与 `config`（自己的配置
// schema，例如白名单字段）。通用配置（连接、分块…）留在 config.ts。
import type z from "@deepseek-ai/schemastery";
import type { OneBotSegment } from "../protocol.ts";

/** 一条解析后的聊天引用；成员由各 adapter 声明。 */
export type ChatRoute =
	| { kind: "private"; user_id: number }
	| { kind: "group"; group_id: number };

/** 路由种类在 {@link ChatRoute} 联合类型里的成员。 */
export type RouteKind = ChatRoute["kind"];

/** 出站/读历史动作：OneBot action 名 + 参数。 */
export interface RouteAction {
	action: string;
	params: Record<string, unknown>;
}

/** 一种路由种类的全部接线方式：新增种类只需在某个 adapter 的 `routes` 里加一条。 */
export interface RouteSpec {
	/** `ChatRoute` 里承载目标号的字段名（会话 id 与目标字符串都用它）。 */
	readonly idField: string;
	/** 身份前缀里的种类标签。 */
	readonly label: (id: number) => string;
	/** 由目标号构造该种类的 route。 */
	readonly build: (id: number) => ChatRoute;
	/** 由目标号字符串构造该种类 route，不合法返回 null。 */
	readonly parse: (raw: string) => ChatRoute | null;
	/** 出站动作。 */
	readonly action: (id: number, message: OneBotSegment[]) => RouteAction;
	/** 读历史动作；该种类没有这个接口时不写。 */
	readonly history?: (id: number, limit: number) => RouteAction;
	/** 读历史失败时附加给模型的提示。 */
	readonly historyHint?: string;
}

/** 一种 adapter 的静态声明。实现见同目录各文件，注册表见 index.ts。 */
export interface Adapter {
	/** adapter 类型名，也是配置 `adapters[].type` 的取值。 */
	readonly type: string;
	/** 该 adapter 支持的全部路由种类。 */
	readonly routes: Record<RouteKind, RouteSpec>;
	/** 路由种类 → 该种类白名单所在的配置字段名；未列出的种类一律不放行。 */
	readonly allowlists: Record<string, string>;
	/** 该 adapter 自己的配置 schema。 */
	readonly config: z<Record<string, unknown>>;
	/** 该 adapter 的默认配置。 */
	readonly defaults: Record<string, unknown>;
	/** 该 adapter 连接实现端所用的配置字段名。 */
	readonly transportUrl?: string;
}
