// OneBot 11 wire helpers and types (ported from the nota project's Rust
// OneBot types; the wire/echo layer itself now lives in onebot.js).
// Dependency-free module: safe to unit-test without any @deepseek-ai package.

/** One message segment as delivered by the implementation. */
export interface OneBotSegment {
	type?: string;
	data?: Record<string, unknown>;
}

/** A OneBot message body: either a plain string or an array of segments. */
export type OneBotMessage = string | OneBotSegment[];

/** OneBot `sender` object (group card preferred over nickname). */
export interface OneBotSender {
	user_id?: number;
	nickname?: string;
	card?: string;
}

/** Any inbound post event (message / notice / meta), discriminated by post_type. */
export interface OneBotPostEvent {
	post_type?: string;
	[key: string]: unknown;
}

/** A `post_type: "message"` event (private or group). */
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

/** Narrow an arbitrary post event to a message event. */
export function isMessageEvent(event: OneBotPostEvent): event is OneBotMessageEvent {
	return event.post_type === "message";
}

/** A message as returned by the history APIs (get_*_msg_history). */
export interface HistoryMessage {
	message_id?: string | number;
	message_seq?: number;
	user_id?: number;
	time?: number;
	message?: OneBotMessage;
	sender?: OneBotSender;
	group_id?: number;
}

/** `data` payload of `get_group_msg_history` / `get_friend_msg_history`. */
export interface MsgHistoryData {
	messages?: HistoryMessage[];
}

/** `data` payload of `get_msg`. */
export interface GetMsgData {
	message_id?: string | number;
	message_type?: string;
	time?: number;
	user_id?: number;
	message?: OneBotMessage;
	sender?: OneBotSender;
}

/** `data` payload of `get_login_info`. */
export interface LoginInfoData {
	user_id?: number;
	nickname?: string;
}

/** `data` payload of `fetch_ptt_text` (NapCat voice-to-text). */
export interface PttTextData {
	text?: string;
}

/** A parsed chat reference (`private:<QQ>` / `group:<群号>`). */
export type ChatRoute =
	| { kind: "private"; user_id: number }
	| { kind: "group"; group_id: number };

/**
 * Per-segment-type text renderers. `text` keeps its content; every other
 * type falls back to the default renderer, which dumps ALL of the segment's
 * `data` as `key=value` pairs (plus the containing message id when given, so
 * the model can fetch content with `onebot_get_content`). Add more entries
 * here for types that need a custom shape.
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
 * Render a message body (string or segment array) to plain text for the LLM
 * with ONE function: text segments keep their content, every other segment
 * renders per its type (default: all `data` fields as `key=value`, plus the
 * containing message id when provided).
 */
export function messageToText(message: OneBotMessage | undefined | null, messageId?: string): string {
	if (typeof message === "string") return message;
	if (!Array.isArray(message)) return "";
	return message.map((segment) => renderSegment(segment, messageId)).join("");
}

/**
 * Best available display name: group card > nickname. Renders as
 * `name(QQ)` and falls back to the bare QQ number when no name is known.
 */
export function identity(sender: OneBotSender | undefined, userId: number | undefined): string {
	const name = String(sender?.card ?? "").trim() || String(sender?.nickname ?? "").trim();
	const id = userId == null ? "" : String(userId);
	return name ? `${name}(${id})` : id;
}

/**
 * Split text into chunks of at most `maxChars` characters so long replies
 * stay under the QQ message length limit.
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
 * Render history messages as readable text for the LLM, one per line:
 * `[HH:MM] name(QQ) 消息ID:<id>: text`.
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
 * Coerce a message id that may arrive as a JSON number or a string.
 */
export function parseMessageId(value: string | number | undefined): string {
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return value;
	return "";
}

/**
 * Parse an adapter-independent chat target (`private:<QQ>` / `group:<群号>`),
 * shared by the outbound (`onebot_send`) and read (`onebot_get_msg_history`)
 * tools and the bridge allowlist checks.
 */
export function parseTarget(target: string | null | undefined): ChatRoute | null {
	const [kind, id] = String(target ?? "").split(":");
	if ((kind === "private" || kind === "group") && /^\d+$/.test(id)) {
		return kind === "private"
			? { kind, user_id: Number(id) }
			: { kind, group_id: Number(id) };
	}
	return null;
}

// ── action builders ─────────────────────────────────────────────────────────
// Outbound actions are typed directly by onebot.js (`WSSendParam`); see
// bridge.sendReply and the tools for the call sites.
