// OneBot-facing tools (ported from nota-onebot crates/nota-onebot/src/tools.rs).
// All tool names carry the `onebot_` prefix: `send_message` is a reserved
// global name in the dsh ecosystem (subagent control), and a scoped prefix
// keeps the whole family collision-free.
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { OneBotBridge } from "./bridge.ts";
import type { GetMsgData, LoginInfoData, MsgHistoryData, OneBotResponse, PttTextData } from "./protocol.ts";
import {
	fetchPttText,
	formatHistory,
	getFriendMsgHistory,
	getGroupMsgHistory,
	getLoginInfo,
	getMsg,
	identity,
	parseMessageId,
	parseTarget,
	toTextWithId,
} from "./protocol.ts";

/**
 * Throw a model-facing error when the implementation did not answer `ok`.
 * Success is `retcode === 0`; an absent `retcode` is accepted only when the
 * implementation still reports `status: "ok"`. Any other answer — including
 * an unsupported/extended action the implementation refuses — throws with
 * the action name, the raw status/retcode, and any `data` error detail, so
 * the agent sees a direct error instead of a silent empty result.
 */
function assertOk(resp: OneBotResponse, action: string, hint?: string): void {
	const ok = resp.retcode === 0 || (resp.retcode == null && resp.status === "ok");
	if (ok) return;
	const data = resp.data as { message?: unknown; error?: unknown } | undefined;
	const detail = data && (data.message || data.error)
		? `, detail=${JSON.stringify(data.message ?? data.error)}`
		: "";
	throw new Error(
		`${action} failed: status=${resp.status} retcode=${resp.retcode}${detail}${hint ? ` — ${hint}` : ""}`,
	);
}

/** Compatibility hint for the NapCat/go-cqhttp extended friend-history API. */
const FRIEND_HISTORY_HINT =
	"get_friend_msg_history is a NapCat/go-cqhttp extension; this OneBot implementation may not " +
	"support reading private chat history — for a single message use onebot_get_content instead";

/**
 * Register every OneBot tool on `ctx.tools`.
 * @param ctx - the plugin context (tool registration is global here).
 * @param bridge - the active {@link OneBotBridge}; tools reach the protocol
 *   through `bridge.api` and outbound/approval through the bridge methods.
 */
export function registerOneBotTools(ctx: Context, bridge: OneBotBridge): void {
	ctx.tools.register(
		defineTool({
			name: "onebot_send",
			description:
				"Send a message to a QQ conversation session. target is private:<QQ> or group:<群号>; the target must be allowlisted or explicitly approved by the user. IMPORTANT: your reply to the chat you are CURRENTLY talking in is delivered automatically at the end of the turn — do not use this tool to reply there, only to message OTHER chats.",
			parameters: {
				target: {
					type: "string",
					required: true,
					description: "Target session, e.g. private:2961354039 or group:551947633",
				},
				content: {
					type: "string",
					required: true,
					description: "Message text to send",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						delivered: { type: "boolean", required: true },
						target: { type: "string", required: true },
						denied_reason: { type: "string" },
					},
				},
				render: (_args, value) => [
					{
						type: "text",
						text: value.delivered
							? `已发送到 ${value.target}`
							: `发送被拒绝：${value.denied_reason ?? "未知原因"}`,
					},
				],
			},
			async execute(args, exec) {
				const target = String(args.target);
				const content = String(args.content);
				if (!target || !content.trim()) {
					throw new Error("target and content must be non-empty strings");
				}
				if (bridge.isAllowedTarget(target)) {
					bridge.sendTarget(target, content);
					return { delivered: true, target };
				}
				if (!exec.agent) {
					return { delivered: false, target, denied_reason: "unavailable" };
				}
				const outcome = await bridge.requestApproval({
					agent: exec.agent,
					toolName: "onebot_send",
					callId: exec.callId,
					signal: exec.signal,
					reason: `persona 想向 ${target} 发送消息：${content.slice(0, 200)}`,
				});
				if (outcome === "allowed-once") {
					bridge.sendTargetApproved(target, content);
					return { delivered: true, target };
				}
				return { delivered: false, target, denied_reason: outcome };
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "onebot_get_msg_history",
			description:
				"Read the recent message history of a QQ chat via the OneBot connection: group history (get_group_msg_history) or private/friend history (get_friend_msg_history). target is private:<QQ> or group:<群号>. Returns the last N messages as text.",
			parameters: {
				target: {
					type: "string",
					required: true,
					description: "Chat to read, e.g. private:2961354039 or group:551947633",
				},
				limit: {
					type: "number",
					description: "Max messages to fetch (default 20, max 100)",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						target: { type: "string", required: true },
						text: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.text }],
			},
			async execute(args) {
				const target = String(args.target);
				const route = parseTarget(target);
				if (!route) throw new Error("target must be private:<QQ> or group:<群号>");
				const limit = args.limit == null ? 20 : Number(args.limit);
				if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
					throw new Error("limit must be an integer between 1 and 100");
				}
				const action =
					route.kind === "group"
						? getGroupMsgHistory(route.group_id, limit)
						: getFriendMsgHistory(route.user_id, limit);
				const resp = await bridge.api.call(action);
				assertOk(resp, action.action, route.kind === "private" ? FRIEND_HISTORY_HINT : undefined);
				const messages = (resp.data as MsgHistoryData | undefined)?.messages ?? [];
				const text = formatHistory(messages);
				return {
					target,
					text: text || `chat ${target} has no readable recent messages`,
				};
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "onebot_get_content",
			description:
				"Get the full content of a specific QQ message by its message id (e.g. the id in a [reply msg id:...], [image msg id:...] or [record msg id:...] segment) and return sender, time and full text.",
			parameters: {
				message_id: {
					type: "string",
					required: true,
					description: "Message id from a [reply msg id:...] or [record msg id:...] segment",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						message_id: { type: "string", required: true },
						message_type: { type: "string", required: true },
						time: { type: "integer", required: true },
						user_id: { type: "integer", required: true },
						sender: { type: "string", required: true },
						text: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.text }],
			},
			async execute(args) {
				const id = parseMessageId(args.message_id);
				if (!id) throw new Error("message_id must be a non-empty string or number");
				const resp = await bridge.api.call(getMsg(id));
				assertOk(resp, "get_msg");
				const data = (resp.data as GetMsgData | undefined) ?? {};
				const messageId = String(data.message_id ?? id);
				const text = data.message != null ? toTextWithId(data.message, messageId) : "";
				const userId = Number(data.user_id) || 0;
				const time = Number(data.time) || 0;
				const ts = time
					? new Date(time * 1000).toLocaleString("zh-CN", { hour12: false })
					: "--";
				return {
					message_id: messageId,
					message_type: data.message_type ?? "unknown",
					time,
					user_id: userId,
					sender: identity(data.sender, userId),
					text: `消息 ${messageId}（${data.message_type ?? "unknown"}，${ts}）${identity(data.sender, userId)}: ${text}`,
				};
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "onebot_status",
			description:
				"Get the OneBot connection status and the bot's own QQ account info (QQ number and nickname) via the OneBot connection.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						user_id: { type: "integer", required: true },
						nickname: { type: "string", required: true },
						connected: { type: "boolean", required: true },
						ws_url: { type: "string", required: true },
					},
				},
				render: (_args, value) => [
					{
						type: "text",
						text: `Bot status: QQ ${value.user_id} (${value.nickname}) · connected: ${value.connected} · ${value.ws_url}`,
					},
				],
			},
			async execute() {
				const connected = bridge.api.isConnected();
				let user_id = 0;
				let nickname = "";
				if (connected) {
					try {
						const resp = await bridge.api.call(getLoginInfo());
						if (resp.retcode === 0) {
							const data = (resp.data as LoginInfoData | undefined) ?? {};
							user_id = Number(data.user_id) || 0;
							nickname = data.nickname ?? "";
						}
					} catch {
						// Not connected in the meantime; report the state as-is.
					}
				}
				return {
					user_id,
					nickname,
					connected,
					ws_url: bridge.config.ws_url,
				};
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "onebot_voice_text",
			description:
				"Transcribe a QQ voice message (语音) into text via the OneBot connection (NapCat fetch_ptt_text). Pass the message id from a [record msg id:...] segment.",
			parameters: {
				message_id: {
					type: "string",
					required: true,
					description: "Message id from a [record msg id:...] segment",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						message_id: { type: "string", required: true },
						text: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.text }],
			},
			async execute(args) {
				const id = parseMessageId(args.message_id);
				if (!id) throw new Error("message_id must be a non-empty string or number");
				// NapCat 的语音转写偶尔会因语音尚未处理完而临时失败，重试几次再放弃。
				let lastError = "";
				for (let attempt = 0; attempt < 3; attempt++) {
					if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
					try {
						const resp = await bridge.api.call(fetchPttText(id));
						assertOk(resp, "fetch_ptt_text");
						const text = ((resp.data as PttTextData | undefined)?.text ?? "").trim();
						return {
							message_id: id,
							text: text ? `语音 ${id} 转文字: ${text}` : `语音 ${id} 没有可转写的文字内容`,
						};
					} catch (err) {
						lastError = err instanceof Error ? err.message : String(err);
					}
				}
				throw new Error(
					`语音 ${id} 转写失败（重试 3 次）：${lastError}。语音可能还在处理中，稍后重试或让用户重新发送`,
				);
			},
		}),
	);
}
