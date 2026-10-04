// 面向 OneBot 的工具。工具名统一带 `onebot_` 前缀：`send_message` 是 dsh 生态的
// 保留名（子 agent 控制用），加前缀避免冲突。
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { WSSendParam } from "onebot.js";
import { parseTarget, routeHistory } from "./adapter/index.ts";
import type { OneBotBridge } from "./bridge.ts";
import type { GetMsgData, LoginInfoData, MsgHistoryData, PttTextData } from "./protocol.ts";
import { formatHistory, identity, messageToText, parseMessageId } from "./protocol.ts";

/**
 * 目标写法的抽象描述。具体有哪些种类由已启用的 adapter 决定，不在这里（也不在
 * 工具描述里）复述——需要知道具体取值就看 adapter 的实现表。
 */
const TARGET_SYNTAX = "<kind>:<id>, where kind is a chat kind of an enabled adapter";

/**
 * 在 `ctx.tools` 上注册全部 OneBot 工具。
 * @param ctx - 插件上下文（此处的工具注册是全局的）。
 * @param bridge - 当前生效的 {@link OneBotBridge}；工具通过 `bridge.api` 访问协议，
 *   并通过 bridge 的方法完成对外发送。
 */
export function registerOneBotTools(ctx: Context, bridge: OneBotBridge): void {
	ctx.tools.register(
		defineTool({
			name: "onebot_send",
			description:
				`Send a message to a OneBot conversation session. target is ${TARGET_SYNTAX}; the target must be allowlisted. THIS is the only way to deliver any message, including your reply to the chat you are CURRENTLY talking in — each call sends immediately (no batching, no auto-send at turn end). To reply in multiple parts, call this tool once per part, in order; you may also answer first, look something up, then answer again.`,
			parameters: {
					target: {
						type: "string",
						required: true,
						description: `Target session (use the current chat's id to reply)`,
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
					},
				},
				render: (_args, value) => [{ type: "text", text: `已发送到 ${value.target}` }],
			},
			async execute(args) {
				const target = String(args.target);
				const content = String(args.content);
				if (!target || !content.trim()) {
					throw new Error("target and content must be non-empty strings");
				}
				if (!bridge.isAllowedTarget(target)) {
					throw new Error(`target ${target} is not in the allowlist`);
				}
				bridge.sendTarget(target, content);
				return { delivered: true, target };
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "onebot_get_msg_history",
			description:
				`Read the recent message history of a OneBot chat via the OneBot connection. target is ${TARGET_SYNTAX}. Returns the last N messages as text.`,
			parameters: {
					target: {
						type: "string",
						required: true,
						description: "Chat to read",
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
				if (!route) throw new Error(`target must be ${TARGET_SYNTAX}`);
				const limit = args.limit == null ? 20 : Number(args.limit);
				if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
					throw new Error("limit must be an integer between 1 and 100");
				}
				// 动作名与参数由种类表提供，不写死种类。该种类没声明 history
				// （实现端不支持该接口）时直接报错，不静默返回空结果。
				const history = routeHistory(route, limit);
				if (!history) {
					throw new Error(`reading message history is not supported for target kind '${route.kind}'`);
				}
				const data = (await bridge.api.invoke(history.action as keyof WSSendParam, history.params as never, {
					hint: history.hint,
				})) as unknown as MsgHistoryData;
				const messages = data?.messages ?? [];
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
				"Get the full content of a specific OneBot message by its message id (e.g. the id in a [reply msg id:...], [image msg id:...] or [record msg id:...] segment) and return sender, time and full text.",
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
				const data = (await bridge.api.invoke("get_msg", { message_id: id })) as unknown as GetMsgData;
				const messageId = String(data?.message_id ?? id);
				const text = data?.message != null ? messageToText(data.message, messageId) : "";
				const userId = Number(data?.user_id) || 0;
				const time = Number(data?.time) || 0;
				const ts = time
					? new Date(time * 1000).toLocaleString("zh-CN", { hour12: false })
					: "--";
				return {
					message_id: messageId,
					message_type: data?.message_type ?? "unknown",
					time,
					user_id: userId,
					sender: identity(data?.sender, userId),
					text: `消息 ${messageId}（${data?.message_type ?? "unknown"}，${ts}）${identity(data?.sender, userId)}: ${text}`,
				};
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "onebot_status",
			description:
				"Get the OneBot connection status and the bot's own account info (account number and nickname) via the OneBot connection.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						user_id: { type: "integer", required: true },
						nickname: { type: "string", required: true },
						connected: { type: "boolean", required: true },
						url: { type: "string", required: true },
					},
				},
				render: (_args, value) => [
					{
						type: "text",
						text: `Bot status: ${value.user_id} (${value.nickname}) · connected: ${value.connected} · ${value.url}`,
					},
				],
			},
			async execute() {
				const connected = bridge.api.connected;
				let user_id = 0;
				let nickname = "";
				if (connected) {
					try {
						const data = (await bridge.api.invoke("get_login_info", {})) as unknown as LoginInfoData;
						user_id = Number(data?.user_id) || 0;
						nickname = data?.nickname ?? "";
					} catch {
						// 期间可能已断开连接；按当前状态如实上报。
					}
				}
				return {
					user_id,
					nickname,
					connected,
					url: bridge.transportUrl,
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
						const data = (await bridge.api.invoke("fetch_ptt_text", { message_id: id })) as unknown as PttTextData;
						const text = (data?.text ?? "").trim();
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
