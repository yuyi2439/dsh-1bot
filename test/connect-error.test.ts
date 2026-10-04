// 启动连接失败报告（src/connect-error.ts）的测试：报文必须携带证据，
// 且绝不回显 token。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { formatConnectFailure, probeForwardWsPort, redactAccessToken } from "../src/connect-error.ts";

const ctx = {
	wsUrl: "ws://127.0.0.1:3001",
	hasAccessToken: false,
	cause: "could not connect to ws://127.0.0.1:3001 after 6 attempts (close code 1006)",
	attempts: 6,
	delaySecs: 1,
	patchPath: "C:\\Users\\me\\.dsh\\profiles\\onebot\\cordis.patch.yml",
};

test("connect failure report carries the evidence and the exact next command", () => {
	const text = formatConnectFailure(ctx, false);
	// 原因必须出现在用户会引用的同一条报文里。
	assert.match(text, /connect_failed/);
	assert.match(text, /after 6 attempts \(close code 1006\)/);
	// 解析后的路径，而不是未展开的 `$DSH_HOME`。
	assert.ok(text.includes(ctx.patchPath), "打印解析后的 patch 路径");
	assert.ok(!text.includes("$DSH_HOME"), "不出现未展开的变量");
	// 尝试了什么，以及进程确实已退出（没有静默自动重试）。
	assert.match(text, /url=ws:\/\/127\.0\.0\.1:3001/);
	assert.match(text, /access_token=未设置/);
	assert.match(text, /最多 6 次、间隔 1s/);
	assert.match(text, /进程已退出，不会自动重连/);
	assert.match(text, /dsh --profile onebot/);
	// 下一步由实测结果选择。
	assert.match(text, /下一步：该端口没有程序在监听/);
	assert.ok(!text.includes("却被拒"), "端口关闭时不应给出相反分支的建议");
	// 单条记录：开头没有前缀，续行有缩进。
	assert.ok(!text.startsWith("["), "前缀由调用方的 logger 添加");
	assert.equal(text.split("\n").length, 6);
});

test("connect failure report reflects the measured TCP reachability", () => {
	const rejected = formatConnectFailure(ctx, true);
	assert.match(rejected, /实测 TCP 端口 可达/);
	assert.match(rejected, /下一步：端口通、却被拒/);
	assert.ok(!rejected.includes("没有程序在监听"), "端口有应答时不给「无人监听」的建议");

	const closed = formatConnectFailure(ctx, false);
	assert.match(closed, /实测 TCP 端口 不可达/);
	assert.match(closed, /下一步：该端口没有程序在监听/);

	// 无法解析的连接地址是配置错误：url 本身不合法。
	const unknown = formatConnectFailure(ctx, null);
	assert.match(unknown, /实测 TCP 端口 未探测/);
	assert.match(unknown, /不是合法的 ws:\/\/ 地址/);
	assert.match(unknown, /先修正 adapter 配置里的 url/);
});

test("connect failure report never echoes the access token", () => {
	const token = "s3cr3t-token-value";
	const text = formatConnectFailure(
		{
			...ctx,
			wsUrl: `ws://127.0.0.1:3001?access_token=${token}`,
			hasAccessToken: true,
			cause: `could not connect to ws://127.0.0.1:3001?access_token=${token}`,
		},
		false,
	);
	assert.ok(!text.includes(token), "token value is absent");
	assert.match(text, /access_token=\*\*\*/);
	assert.match(text, /access_token=已设置/);
	assert.equal(redactAccessToken(`ws://h/?access_token=${token}&x=1`), "ws://h/?access_token=***&x=1");
	assert.equal(redactAccessToken("ws://h:3001"), "ws://h:3001");
});

test("probeForwardWsPort measures the ws_url host:port", async (t) => {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object", "server bound");
	assert.equal(await probeForwardWsPort(`ws://127.0.0.1:${address.port}`), true);
	// 端口 1 上没有任何程序监听（与 test/client.test.ts 的假设相同）。
	assert.equal(await probeForwardWsPort("ws://127.0.0.1:1", 500), false);
	assert.equal(await probeForwardWsPort("not a ws url"), null);
});
