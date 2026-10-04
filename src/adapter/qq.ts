// QQ adapter：把 QQ（OneBot 11 实现，如 NapCat / LLOneBot / Lagrange）接入 dsh。
// 只放 QQ 特有的东西：路由种类、对应的 OneBot action 名、白名单配置字段。
import z from "@deepseek-ai/schemastery";
import type { Adapter, ChatRoute, RouteSpec } from "./types.ts";

/** QQ adapter 的类型名（配置 `adapters[].type` 用它选中本 adapter）。 */
export const QQ_ADAPTER_TYPE = "qq";

/** QQ 的路由种类表；key 就是种类名，出现在会话 id 与目标字符串里。 */
export const qqRoutes = {
	private: {
		idField: "user_id",
		label: (id: number) => "好友",
		build: (id: number): ChatRoute => ({ kind: "private", user_id: id }),
		parse: (raw: string): ChatRoute | null => (/^\d+$/.test(raw) ? { kind: "private", user_id: Number(raw) } : null),
		action: (id: number, message) => ({ action: "send_private_msg", params: { user_id: id, message } }),
		// get_friend_msg_history 是 NapCat/go-cqhttp 扩展，不是所有实现都支持。
		history: (id: number, limit: number) => ({
			action: "get_friend_msg_history",
			params: { user_id: id, message_seq: 0, count: limit },
		}),
		historyHint:
			"get_friend_msg_history is a NapCat/go-cqhttp extension; this OneBot implementation may not " +
			"support reading private chat history — for a single message use onebot_get_content instead",
	},
	group: {
		idField: "group_id",
		label: (id: number) => `群 ${id}`,
		build: (id: number): ChatRoute => ({ kind: "group", group_id: id }),
		parse: (raw: string): ChatRoute | null => (/^\d+$/.test(raw) ? { kind: "group", group_id: Number(raw) } : null),
		action: (id: number, message) => ({ action: "send_group_msg", params: { group_id: id, message } }),
		history: (id: number, limit: number) => ({
			action: "get_group_msg_history",
			params: { group_id: id, message_seq: 0, count: limit },
		}),
	},
} satisfies Record<string, RouteSpec>;

/** QQ 的配置：实现端地址与按路由种类分别列出的白名单（空 = 谁都不放行）。 */
export const qqConfigSchema = z.object({
	/** 实现端的正向 WebSocket 地址（反向 WS / HTTP 未实现）。 */
	url: z.string().default("ws://127.0.0.1:3001"),
	/** 私聊白名单（好友号）。 */
	friend_ids: z.array(z.number()).default([]),
	/** 群白名单。 */
	group_ids: z.array(z.number()).default([]),
});

/** QQ 的默认配置。 */
export const qqDefaults = { url: "ws://127.0.0.1:3001", friend_ids: [], group_ids: [] };

/** QQ 的路由种类 → 白名单字段。 */
export const qqAllowlists: Record<string, string> = {
	private: "friend_ids",
	group: "group_ids",
};

/** QQ adapter 的完整声明。 */
export const qqAdapter = {
	type: QQ_ADAPTER_TYPE,
	routes: qqRoutes,
	allowlists: qqAllowlists,
	config: qqConfigSchema as unknown as Adapter["config"],
	defaults: qqDefaults,
	transportUrl: "url",
} satisfies Adapter;
