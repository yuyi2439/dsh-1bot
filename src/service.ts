// 暴露给其他插件的 `ctx.onebot` 服务表面：本插件对外唯一的 API。
// 实现在 OneBotBridge 上；这里只做收窄与转发，别处要改对外形状就改这个文件。
import type { OneBotClient } from "onebot.js";
import type { ChatRoute } from "./adapter/index.ts";
import type { OneBotBridge } from "./bridge.ts";

/** `ctx.onebot` 的服务形状。 */
export interface OnebotService {
	/** 带 echo 关联的动作 API（供需要直接调 OneBot action 的插件）。 */
	client: OneBotClient;
	/** 目标字符串是否在白名单内。 */
	isAllowedTarget(target: string): boolean;
	/** 发往某目标；目标非法或不在白名单时抛错。 */
	send(target: string, text: string): void;
	/** 直接向某路由发送（内部用的路由形状，比目标字符串省一次解析）。 */
	sendReply(route: ChatRoute, text: string): void;
}

/** 由当前 bridge 造出 `ctx.onebot` 的服务值。 */
export function publicService(bridge: OneBotBridge): OnebotService {
	return {
		client: bridge.client,
		isAllowedTarget: (target) => bridge.isAllowedTarget(target),
		send: (target, text) => bridge.sendTarget(target, text),
		sendReply: (route, text) => bridge.sendReply(route, text),
	};
}
