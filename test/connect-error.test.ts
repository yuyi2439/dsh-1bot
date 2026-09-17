// Tests for the startup connect-failure report (src/connect-error.ts): the
// message must carry the evidence, and it must never echo a token.
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
	// The cause (which the raw error used to carry in a separate, unlinked
	// record) belongs in the same message the user quotes.
	assert.match(text, /connect_failed/);
	assert.match(text, /after 6 attempts \(close code 1006\)/);
	// The resolved path, not an unexpanded `$DSH_HOME`.
	assert.ok(text.includes(ctx.patchPath), "resolved patch path is printed");
	assert.ok(!text.includes("$DSH_HOME"), "no unexpanded variable");
	// What was attempted, and that the process is gone (no silent auto-retry).
	assert.match(text, /ws_url=ws:\/\/127\.0\.0\.1:3001/);
	assert.match(text, /access_token=未设置/);
	assert.match(text, /最多 6 次、间隔 1s/);
	assert.match(text, /进程已退出，不会自动重连/);
	assert.match(text, /dsh --profile onebot/);
	// The next step is selected by the measurement, not a both-ways checklist.
	assert.match(text, /下一步：该端口没有程序在监听/);
	assert.ok(!text.includes("却被拒"), "the opposite branch is not offered when the port is closed");
	// A single record: no leading prefix, continuation lines indented.
	assert.ok(!text.startsWith("["), "the caller's logger adds the prefix");
	assert.equal(text.split("\n").length, 6);
});

test("connect failure report reflects the measured TCP reachability", () => {
	const rejected = formatConnectFailure(ctx, true);
	assert.match(rejected, /实测 TCP 端口 可达/);
	assert.match(rejected, /下一步：端口通、却被拒/);
	assert.ok(!rejected.includes("没有程序在监听"), "no closed-port advice when the port answers");

	const closed = formatConnectFailure(ctx, false);
	assert.match(closed, /实测 TCP 端口 不可达/);
	assert.match(closed, /下一步：该端口没有程序在监听/);

	// An unparseable ws_url is a config error in itself, not "server down".
	const unknown = formatConnectFailure(ctx, null);
	assert.match(unknown, /实测 TCP 端口 未探测/);
	assert.match(unknown, /不是合法的 ws:\/\/ 地址/);
	assert.match(unknown, /先修正 ws_url/);
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
	// Nothing listens on port 1 (the same assumption test/client.test.ts makes).
	assert.equal(await probeForwardWsPort("ws://127.0.0.1:1", 500), false);
	assert.equal(await probeForwardWsPort("not a ws url"), null);
});
