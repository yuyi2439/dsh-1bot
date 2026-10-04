// OneBot 11 报文类型与辅助函数（报文/echo 层由 onebot.js 提供）。零依赖模块：
// 不需要任何 @deepseek-ai 包即可单测。
//
// 这里只放与平台无关的报文处理：消息段渲染、身份显示名、分块、历史格式化。
// 平台接线方式在 adapter/ 下（契约见 adapter/types.ts）。

/** 实现端下发的一个消息段。 */
export interface OneBotSegment {
	type?: string;
	data?: Record<string, unknown>;
}

/** OneBot 消息体：纯字符串，或消息段数组。 */
export type OneBotMessage = string | OneBotSegment[];

/** OneBot 的 `sender` 对象（群名片优先于昵称）。 */
export interface OneBotSender {
	user_id?: number;
	nickname?: string;
	card?: string;
}

/** 任意入站 post 事件（message / notice / meta），按 post_type 区分。 */
export interface OneBotPostEvent {
	post_type?: string;
	[key: string]: unknown;
}

/** `post_type: "message"` 事件（种类由 `message_type` 表示）。 */
export interface OneBotMessageEvent {
	post_type: "message";
	message_type: string;
	message_id?: number;
	user_id: number;
	self_id?: number;
	time?: number;
	message?: OneBotMessage;
	group_id?: number;
	sender?: OneBotSender;
	sub_type?: string;
	[key: string]: unknown;
}

/** 把任意 post 事件收窄为消息事件。 */
export function isMessageEvent(event: OneBotPostEvent): event is OneBotMessageEvent {
	return event.post_type === "message";
}

/** 历史接口（get_*_msg_history）返回的一条消息。 */
export interface HistoryMessage {
	message_id?: string | number;
	message_seq?: number;
	user_id?: number;
	time?: number;
	message?: OneBotMessage;
	sender?: OneBotSender;
	group_id?: number;
}

/** `get_*_msg_history` 的 `data` 载荷。 */
export interface MsgHistoryData {
	messages?: HistoryMessage[];
}

/** `get_msg` 的 `data` 载荷。 */
export interface GetMsgData {
	message_id?: string | number;
	message_type?: string;
	time?: number;
	user_id?: number;
	message?: OneBotMessage;
	sender?: OneBotSender;
}

/** `get_login_info` 的 `data` 载荷。 */
export interface LoginInfoData {
	user_id?: number;
	nickname?: string;
}

/** `fetch_ptt_text`（NapCat 语音转写）的 `data` 载荷。 */
export interface PttTextData {
	text?: string;
}

/**
 * 按消息段类型渲染文本。`text` 段保留其内容；其余类型落到默认渲染器，把该段
 * 的**全部** `data` 倾倒成 `key=value`（给了消息 id 时一并带上，使模型能用
 * `onebot_get_content` 取内容）。需要自定义形状的类型在此加表项。
 */
const SEGMENT_RENDERERS: Record<string, (segment: OneBotSegment, messageId?: string) => string> = {
	text: (segment) => String(segment.data?.text ?? ""),
};

function renderSegment(segment: OneBotSegment | undefined, messageId?: string): string {
	if (!segment?.type) return "";
	const render = SEGMENT_RENDERERS[segment.type];
	if (render) return render(segment, messageId);
	const id = messageId ? ` msg id:${messageId}` : "";
	const kv = Object.entries(segment.data ?? {})
		.map(([key, value]) => ` ${key}=${String(value)}`)
		.join("");
	return `[${segment.type}${id}${kv}]`;
}

/**
 * 用**一个**函数把消息体（字符串或消息段数组）渲染成给 LLM 的纯文本：text 段
 * 保留内容，其余段按类型渲染（默认：全部 `data` 字段作 `key=value`，给了消息 id
 * 时一并带上）。
 */
export function messageToText(message: OneBotMessage | undefined | null, messageId?: string): string {
	if (typeof message === "string") return message;
	if (!Array.isArray(message)) return "";
	return message.map((segment) => renderSegment(segment, messageId)).join("");
}

/**
 * 可用的展示名：群名片 > 昵称。渲染为 `name(QQ)`，完全不知道名字时退回裸号码。
 */
export function identity(sender: OneBotSender | undefined, userId: number | undefined): string {
	const name = String(sender?.card ?? "").trim() || String(sender?.nickname ?? "").trim();
	const id = userId == null ? "" : String(userId);
	return name ? `${name}(${id})` : id;
}

/**
 * 把文本切成每块至多 `maxChars` 个字符，使长回复不超出消息长度上限。
 */
export function chunkText(text: string, maxChars: number): string[] {
	if (maxChars <= 0) return [text];
	const chunks: string[] = [];
	let current = "";
	let count = 0;
	for (const ch of text) {
		if (count === maxChars) {
			chunks.push(current);
			current = "";
			count = 0;
		}
		current += ch;
		count += 1;
	}
	if (current !== "") chunks.push(current);
	return chunks;
}

/**
 * 把历史消息渲染成给 LLM 的可读文本，一行一条：
 * `[HH:MM] name(QQ) 消息ID:<id>: text`。
 */
export function formatHistory(messages: readonly HistoryMessage[] | undefined): string {
	const out: string[] = [];
	for (const msg of messages ?? []) {
		const text = msg?.message != null ? messageToText(msg.message, parseMessageId(msg.message_id)) : "";
		if (!text.trim()) continue;
		const who = identity(msg.sender, msg.user_id);
		const time = new Date((msg.time ?? 0) * 1000);
		const hhmm = Number.isFinite(time.getTime())
			? `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`
			: "--:--";
		out.push(`[${hhmm}] ${who} 消息ID:${parseMessageId(msg.message_id)}: ${text}`);
	}
	return out.join("\n");
}

/**
 * 把可能以 JSON 数字或字符串到达的消息 id 统一成字符串。
 */
export function parseMessageId(value: string | number | undefined): string {
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return value;
	return "";
}

// ── 动作构造 ────────────────────────────────────────────────────────────────
// 出站与读历史的动作名一律由 adapter 声明提供（见 adapter/types.ts 的
// RouteSpec）；本模块不含任何平台相关的 action 名。
