// OneBot 11 wire helpers and types (ported from nota-onebot
// crates/nota-onebot/src/types.rs). Dependency-free module: safe to unit-test
// without any @deepseek-ai package.
import { randomUUID } from "node:crypto";

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

/** One outgoing action with its correlation echo. */
export interface OneBotAction {
	action: string;
	params: Record<string, unknown>;
	echo: string;
}

/** The implementation's response to one action, matched by `echo`. */
export interface OneBotResponse {
	status?: string;
	retcode?: number;
	echo?: string;
	data?: unknown;
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

/** An approve/deny command parsed from chat text. */
export interface ApprovalCommand {
	approved: boolean;
	seq: number | null;
}

/**
 * Flatten a message body to plain text. Non-text segments become `[<type>]`
 * placeholders without a message id (used for local parsing, e.g. approval
 * commands).
 */
export function toText(message: OneBotMessage | undefined | null): string {
	if (typeof message === "string") return message;
	if (!Array.isArray(message)) return "";
	return message.map(segmentToText).join("");
}

/**
 * Flatten a message body to plain text for the LLM. Text segments keep their
 * content; every other segment is rendered uniformly as
 * `[<type> msg id:<messageId>]` so the persona knows what kind of media
 * arrived and can fetch its content with a tool (`onebot_get_msg`,
 * `onebot_voice_text`, …).
 */
export function toTextWithId(message: OneBotMessage | undefined | null, messageId: string): string {
	if (typeof message === "string") return message;
	if (!Array.isArray(message)) return "";
	return message.map((segment) => segmentToTextWithId(segment, messageId)).join("");
}

function segmentToText(segment: OneBotSegment | undefined): string {
	if (segment?.type === "text") return String(segment?.data?.text ?? "");
	return `[${segment?.type ?? "unknown"}]`;
}

function segmentToTextWithId(segment: OneBotSegment | undefined, messageId: string): string {
	if (segment?.type === "text") return String(segment?.data?.text ?? "");
	return `[${segment?.type ?? "unknown"} msg id:${messageId}]`;
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
 * Parse an approve/deny command from a chat message: `同意` / `批准` /
 * `拒绝`, optionally with a 1-based queue position (`同意2`).
 */
export function parseApproval(text: string | undefined | null): ApprovalCommand | null {
	const trimmed = String(text ?? "").trim();
	for (const [prefix, approved] of [
		["同意", true],
		["批准", true],
		["拒绝", false],
	] as const) {
		if (!trimmed.startsWith(prefix)) continue;
		const rest = trimmed.slice(prefix.length).trim();
		if (rest === "") return { approved, seq: null };
		if (/^\d+$/.test(rest)) return { approved, seq: Number(rest) };
	}
	return null;
}

/**
 * Render history messages as readable text for the LLM, one per line:
 * `[HH:MM] name(QQ) 消息ID:<id>: text`.
 */
export function formatHistory(messages: readonly HistoryMessage[] | undefined): string {
	const out: string[] = [];
	for (const msg of messages ?? []) {
		const text = msg?.message != null ? toTextWithId(msg.message, parseMessageId(msg.message_id)) : "";
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
 * shared by the outbound (`onebot_send`) and read (`onebot_read`) tools and
 * the bridge allowlist checks.
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
// Each action carries a fresh `echo` that the implementation echoes back on
// its response; the client correlates by it.

/** `send_private_msg` action. */
export function sendPrivateMsg(userId: number, text: string): OneBotAction {
	return {
		action: "send_private_msg",
		params: { user_id: userId, message: [{ type: "text", data: { text } }] },
		echo: randomUUID(),
	};
}

/** `send_group_msg` action. */
export function sendGroupMsg(groupId: number, text: string): OneBotAction {
	return {
		action: "send_group_msg",
		params: { group_id: groupId, message: [{ type: "text", data: { text } }] },
		echo: randomUUID(),
	};
}

/** NapCat / go-cqhttp extended `get_group_msg_history` action. */
export function getGroupMsgHistory(groupId: number, count: number): OneBotAction {
	return {
		action: "get_group_msg_history",
		params: { group_id: groupId, message_seq: 0, count },
		echo: randomUUID(),
	};
}

/** NapCat / go-cqhttp extended `get_friend_msg_history` action. */
export function getFriendMsgHistory(userId: number, count: number): OneBotAction {
	return {
		action: "get_friend_msg_history",
		params: { user_id: userId, message_seq: 0, count },
		echo: randomUUID(),
	};
}

/** Standard `get_login_info` action. */
export function getLoginInfo(): OneBotAction {
	return {
		action: "get_login_info",
		params: {},
		echo: randomUUID(),
	};
}

/** Standard `get_msg` action. */
export function getMsg(messageId: string | number): OneBotAction {
	return {
		action: "get_msg",
		params: { message_id: messageId },
		echo: randomUUID(),
	};
}

/** NapCat extended `fetch_ptt_text` action (voice-to-text). */
export function fetchPttText(messageId: string | number): OneBotAction {
	return {
		action: "fetch_ptt_text",
		params: { message_id: String(messageId) },
		echo: randomUUID(),
	};
}
