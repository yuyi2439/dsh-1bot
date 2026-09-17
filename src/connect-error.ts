// Shapes the fatal "cannot connect at startup" report (used by apply() in
// index.ts). The old wording asserted "OneBot 服务器连不上" — a guess, because
// the same catch also handles failures that never touched the network (an
// unparseable ws_url, missing client options) — and it dropped every piece of
// evidence that tells the two real cases apart. This module reports what is
// measurable instead: the resolved config path, the URL actually attempted,
// whether a token was configured, the TCP reachability of the target port, and
// the startup retry budget with its knobs. It reads and writes no config file.
import { connect as netConnect } from "node:net";

/** Secret-safe rendering: a token pasted into `ws_url` must not be echoed. */
export function redactAccessToken(text: string): string {
	return text.replace(/([?&]access_token=)[^&\s]*/gi, "$1***");
}

/**
 * Whether a TCP connection to the `ws_url` host/port can be established.
 * Best-effort and never throwing: `null` means "not probed" because the URL
 * does not parse — which is itself a configuration error worth reporting.
 * This is evidence, not a diagnosis: a reachable port proves something is
 * listening, not that it is the OneBot implementation.
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
		// WHATWG `hostname` keeps IPv6 brackets, which `net.connect` will not resolve.
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

/** Inputs for {@link formatConnectFailure}. */
export interface ConnectFailure {
	/** `ws_url` from the plugin config (may embed a token; it is redacted). */
	wsUrl: string;
	/** Whether `access_token` is set — the value itself is never printed. */
	hasAccessToken: boolean;
	/** Message of the error thrown by onebot.js's `connect()`. */
	cause: string;
	/** Total startup attempts (`connect_retries + 1`) and their delay. */
	attempts: number;
	delaySecs: number;
	/** Resolved profile patch path (`profilePatchPath()`), not `$DSH_HOME/...`. */
	patchPath: string;
}

/**
 * Measured reachability → the sentence that reports it and the single next step
 * it implies. "Nothing is listening" and "reachable but rejected" need opposite
 * first checks, so the report recommends the one the probe supports instead of
 * printing a checklist that makes the user guess which half applies.
 */
const PROBE = {
	reachable: {
		text: "可达（有程序在监听该端口，但也可能不是 OneBot 实现）",
		next: "端口通、却被拒 —— 核对 access_token 与该实现端的设置是否一致、ws_url 的路径是否正确，"
			+ "并确认该端口上确实是 OneBot 实现。",
	},
	unreachable: {
		text: "不可达（该端口上没有程序在监听）",
		next: "该端口没有程序在监听 —— 启动 OneBot 实现（NapCat / LLOneBot / Lagrange）并开启正向 WebSocket，"
			+ "使其监听端口与 ws_url 一致。",
	},
	unknown: {
		text: "未探测（ws_url 不是合法的 ws:// 地址——这本身就是配置错误）",
		next: "先修正 ws_url（须为 ws://host:port）；地址无误时，再按端口不可达（启动实现端并开启正向 "
			+ "WebSocket）或端口可达却被拒（核对 access_token 与 ws_url 路径）排查。",
	},
} as const;

/** Table key for a probe result; `null` (not probed) is not a failure mode. */
function probeKey(reachable: boolean | null): keyof typeof PROBE {
	return reachable === null ? "unknown" : reachable ? "reachable" : "unreachable";
}

/**
 * One self-contained record (multi-line, indented) instead of several isolated
 * `log.error` calls: this is a single event, and the line a user quotes must
 * carry the data rather than only advice.
 */
export function formatConnectFailure(ctx: ConnectFailure, reachable: boolean | null): string {
	const probe = PROBE[probeKey(reachable)];
	return [
		`无法连接 OneBot 服务器 (connect_failed)：${redactAccessToken(ctx.cause)}`,
		`  ws_url=${redactAccessToken(ctx.wsUrl)} access_token=${ctx.hasAccessToken ? "已设置" : "未设置"}；实测 TCP 端口 ${probe.text}`,
		`  配置：${ctx.patchPath}（id 定向 patch 整段替换 config，须重述所有字段）`,
		`  启动预算：最多 ${ctx.attempts} 次、间隔 ${ctx.delaySecs}s（connect_retries / connect_retry_delay_secs 可调）；进程已退出，不会自动重连。`,
		`  下一步：${probe.next}`,
		"  改完运行：dsh --profile onebot",
	].join("\n");
}
