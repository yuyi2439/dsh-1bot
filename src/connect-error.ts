// 构造启动时"无法连接"的致命报告。同一个 catch 也覆盖没碰到网络的失败，所以
// 报告只陈述可测量的事实：配置路径、实际尝试的 URL、token 是否设置、目标端口的
// TCP 可达性、启动重试预算。不读写任何配置文件。
import { connect as netConnect } from "node:net";

/** token 绝不原样回显。 */
export function redactAccessToken(text: string): string {
	return text.replace(/([?&]access_token=)[^&\s]*/gi, "$1***");
}

/**
 * 能否与该地址的主机/端口建立 TCP 连接。`null` = URL 无法解析，即未探测。
 * 这是证据而非诊断：端口可达只说明有程序在监听。
 */
export async function probeForwardWsPort(wsUrl: string, timeoutMs = 1000): Promise<boolean | null> {
	let target: URL;
	try {
		target = new URL(wsUrl);
	} catch {
		return null;
	}
	const port = target.port !== "" ? Number(target.port) : target.protocol === "wss:" ? 443 : 80;
	return await new Promise<boolean>((resolve) => {
		// WHATWG 的 `hostname` 保留 IPv6 方括号，`net.connect` 不认。
		const socket = netConnect({ host: target.hostname.replace(/^\[|\]$/g, ""), port });
		let settled = false;
		const done = (reachable: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(reachable);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

/** {@link formatConnectFailure} 的输入。 */
export interface ConnectFailure {
	/** 实际尝试连接的地址；可能内嵌 token，会被脱敏。 */
	wsUrl: string;
	/** `access_token` 是否已设置——其值绝不打印。 */
	hasAccessToken: boolean;
	/** onebot.js 的 `connect()` 抛出的错误 message。 */
	cause: string;
	/** 启动尝试总次数（`connect_retries + 1`）及其间隔。 */
	attempts: number;
	delaySecs: number;
	/** 解析后的 profile patch 路径。 */
	patchPath: string;
}

/** 探测结果 → 那句话，以及由此推出的唯一下一步。 */
const PROBE = {
	reachable: {
		text: "可达（有程序在监听该端口，但也可能不是 OneBot 实现）",
		next: "端口通、却被拒 —— 核对 access_token 与该实现端的设置是否一致、url 的路径是否正确，"
			+ "并确认该端口上确实是 OneBot 实现。",
	},
	unreachable: {
		text: "不可达（该端口上没有程序在监听）",
		next: "该端口没有程序在监听 —— 启动 OneBot 实现（NapCat / LLOneBot / Lagrange）并开启正向 WebSocket，"
			+ "使其监听端口与 url 一致。",
	},
	unknown: {
		text: "未探测（url 不是合法的 ws:// 地址——这本身就是配置错误）",
		next: "先修正 adapter 配置里的 url（须为 ws://host:port）；地址无误时，再按端口不可达（启动实现端并"
			+ "开启正向 WebSocket）或端口可达却被拒（核对 access_token 与 url 路径）排查。",
	},
} as const;

/**
 * 用一条自包含的多行记录代替若干条孤立日志：这是一个单一事件，用户贴出去的那
 * 一行必须自带数据，而不只是建议。
 */
export function formatConnectFailure(ctx: ConnectFailure, reachable: boolean | null): string {
	const probe = PROBE[reachable === null ? "unknown" : reachable ? "reachable" : "unreachable"];
	return [
		`无法连接 OneBot 服务器 (connect_failed)：${redactAccessToken(ctx.cause)}`,
		`  url=${redactAccessToken(ctx.wsUrl)} access_token=${ctx.hasAccessToken ? "已设置" : "未设置"}；实测 TCP 端口 ${probe.text}`,
		`  配置：${ctx.patchPath}（id 定向 patch 整段替换 config，须重述所有字段）`,
		`  启动预算：最多 ${ctx.attempts} 次、间隔 ${ctx.delaySecs}s（connect_retries / connect_retry_delay_secs 可调）；进程已退出，不会自动重连。`,
		`  下一步：${probe.next}`,
		"  改完运行：dsh --profile onebot",
	].join("\n");
}
