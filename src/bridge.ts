// OneBot ⇄ dsh agent 桥接层：插件的中枢，持有完整的 OneBotClient 与 apply 收到的
// Context，dsh 服务（agents / sessions / sessionPersistence）都从 ctx 上取。
//
// 每个聊天对应一个 dsh agent + session，入站消息驱动回合；发送**一律**由
// onebot_send 工具显式发起，没有回复槽，也没有自动发送。
import type { Context } from "@deepseek-ai/cordis";
import { mkdir } from "node:fs/promises";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { OneBotClient, WSSendParam } from "onebot.js";
import { allowlistFor, parseTarget, routeId, routeSpecFor, routeTarget, transportUrl, type ChatRoute } from "./adapter/index.ts";
import { chatWorkspace, DEFAULTS, type OnebotConfig } from "./config.ts";
import type { OneBotMessageEvent, OneBotPostEvent } from "./protocol.ts";
import { chunkText, isMessageEvent, messageToText } from "./protocol.ts";
import { chatRoute, messageRoute } from "./session.ts";

/** OneBot 聊天 ⇄ dsh agent 桥接层。 */
export class OneBotBridge {
	readonly ctx: Context;
	readonly config: OnebotConfig;
	readonly client: OneBotClient;
	/** 带 echo 关联的动作 API，供工具使用。 */
	readonly api: OneBotClient;

	constructor(ctx: Context, config: OnebotConfig, client: OneBotClient) {
		this.ctx = ctx;
		this.config = config;
		this.client = client;
		this.api = client;
	}

	/** 当前连接的实现端地址；未配置时为空串。 */
	get transportUrl(): string {
		return transportUrl(this.config) ?? "";
	}

	// ── 入站 ──────────────────────────────────────────────────────────────

	/** 处理一个 OneBot post 事件；只对 `message` 事件动作，永不 reject。 */
	async onMessageEvent(event: OneBotPostEvent): Promise<void> {
		const logger = this.ctx.logger("onebot");
		try {
			if (!isMessageEvent(event)) return;
			const msg: OneBotMessageEvent = event;
			if (msg.user_id === msg.self_id) {
				logger.info(`ignored own message (user_id=${msg.user_id})`);
				return;
			}
			if (!this.isAllowed(msg)) {
				logger.info(
					`ignored message from non-allowlisted chat (type=${msg.message_type} ` +
						`user_id=${msg.user_id}${msg.group_id != null ? ` group_id=${msg.group_id}` : ""})`,
				);
				return;
			}

			let text = messageToText(msg.message, String(msg.message_id ?? ""));
			if (!text.trim()) {
				logger.info(`ignored empty message from ${msg.message_type}:${msg.user_id}`);
				return;
			}
			if (this.config.prefix) {
				if (!text.startsWith(this.config.prefix)) {
					logger.info(`ignored message without prefix '${this.config.prefix}' from ${msg.message_type}:${msg.user_id}`);
					return;
				}
				text = text.slice(this.config.prefix.length).trimStart();
			}

			const route = chatRoute(msg);
			if (!route) return;
			logger.info(`message from ${route.sessionId}: ${text.slice(0, 200)}`);
			await this.enqueueTurn(route.sessionId, route.prefix + text);
		} catch (err) {
			logger.warn(`event handling failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** 该消息事件是否来自放行的聊天。 */
	isAllowed(msg: OneBotMessageEvent): boolean {
		const route = messageRoute(msg);
		return route != null && this.isAllowedRoute(route);
	}

	/** 目标字符串是否在白名单内。 */
	isAllowedTarget(target: string): boolean {
		const route = parseTarget(target);
		return route != null && this.isAllowedRoute(route);
	}

	private isAllowedRoute(route: ChatRoute): boolean {
		return allowlistFor(this.config, route).includes(routeId(route));
	}

	/**
	 * 把一个回合交给这个聊天的 agent：没有活 agent 就建一个（已有持久化日志则
	 * resume，否则 create），再 followup。串行与排队由 dsh agent 自己的 inbox
	 * 负责，本插件不再排一层队列。
	 */
	async enqueueTurn(sessionId: string, text: string): Promise<void> {
		const id = SessionId(sessionId);
		const agents = this.ctx.agents;
		let agent = agents.get(id);
		if (!agent) {
			// resume 沿用日志里的 cwd，但仍要保证工作区存在。
			const cwd = chatWorkspace(this.config.workspace_root, sessionId);
			await mkdir(cwd, { recursive: true });
			// agentDefaultModel 是可选的（没有它就按 agent-loop 的默认模型走），
			// 所以按名字取、取不到就不装模型选择。
			const selection = this.ctx.get("agentDefaultModel")?.currentSelection();
			const setup = selection
				? (agentCtx: Context) => {
						installModelSelection(agentCtx, { current: selection, assembled: undefined });
				  }
				: undefined;
			const agentOptions = selection ? { provider: selection.provider, model: selection.model } : {};
			// 服务的类型声明来自声明它的包；持久化后端的声明包还没有成为本插件的依赖，
			// 所以这里只能按名字取（值是同一个 ctx.sessionPersistence）。
			const durable = await this.ctx.get("sessionPersistence")!.stat(id);
			const handle = durable
				? await agents.resume({ resumeSessionId: id, agentOptions, setup })
				: await agents.create({ sessionId: id, meta: { cwd }, agentOptions, setup });
			agent = handle.agent;
		}
		agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
		await agent.whenIdle();
		await this.ctx.sessions.flush(agent.session);
	}

	// ── 出站 ──────────────────────────────────────────────────────────────

	/**
	 * 向某路由发送回复，按 `reply_chunk_size` 切分，分块间按
	 * `reply_chunk_delay_ms` 限速。同步 fire-and-forget：每块失败各自记日志。
	 * 动作名与参数来自该种类所属 adapter。
	 */
	sendReply(route: ChatRoute, text: string): void {
		const logger = this.ctx.logger("onebot");
		const maxChars = this.config.reply_chunk_size ?? DEFAULTS.reply_chunk_size;
		const delay = Math.max(0, this.config.reply_chunk_delay_ms ?? DEFAULTS.reply_chunk_delay_ms);
		const target = routeTarget(route);
		logger.info(`send to ${target}: ${text.slice(0, 200)}`);
		const chunks = chunkText(text, maxChars);
		const sendOne = (chunk: string): void => {
			const message = [{ type: "text", data: { text: chunk } }];
			const { action, params } = routeSpecFor(route.kind)!.action(routeId(route), message);
			this.client
				.send(action as keyof WSSendParam, params as never)
				.catch((err) => logger.warn(err instanceof Error ? err.message : String(err)));
		};
		const sendChunk = (index: number): void => {
			if (index >= chunks.length) return;
			sendOne(chunks[index]);
			if (index + 1 < chunks.length && delay > 0) setTimeout(() => sendChunk(index + 1), delay);
			else if (index + 1 < chunks.length) sendChunk(index + 1);
		};
		sendChunk(0);
	}

	/** 发往某目标；目标非法或不在白名单时抛错。 */
	sendTarget(target: string, text: string): void {
		const route = parseTarget(target);
		if (!route) throw new Error(`invalid target: ${target}`);
		if (!this.isAllowedRoute(route)) throw new Error(`target ${target} is not in the allowlist`);
		this.sendReply(route, text);
	}
}
