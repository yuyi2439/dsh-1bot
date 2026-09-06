// Bridge-level tests: exercise the outbound path (sendReply) and the inbound
// queue (enqueueTurn flood cap) through fakes, so sending/chunking/pacing/
// validation and queue bounds are covered without a live OneBot connection
// or a full agent run.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import { OneBotBridge } from "../src/bridge.ts";
import type { OnebotConfig } from "../src/types.ts";

/** Minimal client surface the bridge touches on the outbound path. */
interface FakeClient {
	send(method: string, params: unknown): Promise<unknown>;
}

const config: OnebotConfig = {
	enabled: true,
	mode: "ws",
	ws_url: "ws://127.0.0.1:3001",
	access_token: "",
	prefix: "",
	friend_ids: [42],
	group_ids: [30003],
	connect_retries: 5,
	connect_retry_delay_secs: 1,
	reply_chunk_size: 4000,
	reply_chunk_delay_ms: 1,
	max_pending_turns: 8,
	console_log: true,
};

function makeBridge(
	send: (method: string, params: unknown) => Promise<unknown>,
	overrides: Partial<OnebotConfig> = {},
): OneBotBridge {
	const client = { send } as unknown as ConstructorParameters<typeof OneBotBridge>[0]["client"];
	return new OneBotBridge({
		ctx: {} as Context,
		config: { ...config, ...overrides },
		client,
		agents: { create: async () => ({}) } as never,
		sessions: { flush: async () => true } as never,
	});
}

test("sendReply sends every call, routing group vs private", () => {
	const calls: Array<{ method: string; params: any }> = [];
	const bridge = makeBridge((method, params) => {
		calls.push({ method, params });
		return Promise.resolve();
	});
	bridge.sendReply({ kind: "group", group_id: 30003 }, "hello");
	bridge.sendReply({ kind: "group", group_id: 30003 }, "hello");
	bridge.sendReply({ kind: "private", user_id: 42 }, "hello");
	assert.equal(calls.length, 3, "every call is sent as-is (no dedupe)");
	assert.equal(calls[0].method, "send_group_msg");
	assert.equal(calls[0].params.group_id, 30003);
	assert.equal(calls[1].method, "send_group_msg");
	assert.equal(calls[2].method, "send_private_msg");
	assert.equal(calls[2].params.user_id, 42);
});

test("sendReply chunks long text at the configured size, pacing between chunks", async () => {
	const calls: Array<{ method: string; params: any }> = [];
	const bridge = makeBridge((method, params) => {
		calls.push({ method, params });
		return Promise.resolve();
	});
	const longText = "x".repeat(5000);
	bridge.sendReply({ kind: "group", group_id: 30003 }, longText);
	// The first chunk goes out immediately; the second waits out the pacing
	// delay, so poll briefly instead of asserting synchronously.
	await waitFor(() => calls.length === 2);
	assert.equal(calls.length, 2, "5000 chars at a 4000 cap is two chunks");
	const texts = calls.map((c) => (c.params.message as Array<{ data: { text: string } }>)[0].data.text);
	assert.equal(texts[0].length, 4000);
	assert.equal(texts[1].length, 1000);
});

test("sendTarget throws for invalid or non-allowlisted targets", () => {
	const bridge = makeBridge(() => Promise.resolve());
	assert.throws(() => bridge.sendTarget("bogus", "x"), /invalid target/);
	assert.throws(() => bridge.sendTarget("private:999", "x"), /not in the allowlist/);
});

/** Wait until the predicate holds (poll every 5ms). */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("enqueueTurn caps the per-chat queue and drops overflow with a warning", async () => {
	const warns: string[] = [];
	const log = {
		info() {},
		warn: (msg?: unknown) => warns.push(String(msg)),
	};
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const followups: string[] = [];
	// AgentHandle shape: { agent, dispose } — runTurn destructures `agent`
	// off the handle and calls whenIdle/followup on it.
	const agent = {
		session: {},
		whenIdle: () => gate,
		followup: (msg: { content: Array<{ text: string }> }) => followups.push(msg.content[0].text),
	};
	const client = { send: async () => {} } as unknown as ConstructorParameters<typeof OneBotBridge>[0]["client"];
	const bridge = new OneBotBridge({
		ctx: {} as Context,
		config: { ...config, max_pending_turns: 2 },
		client,
		log: log as unknown as ConstructorParameters<typeof OneBotBridge>[0]["log"],
		agents: { create: async () => ({ agent, dispose: async () => {} }) } as never,
		sessions: { flush: async () => true } as never,
	});
	// The running turn blocks on `gate`, so every later message queues. The
	// returned promises only settle once the turns complete — do not await.
	bridge.enqueueTurn("onebot-private-42", "one");
	bridge.enqueueTurn("onebot-private-42", "two");
	bridge.enqueueTurn("onebot-private-42", "three");
	assert.ok(warns.some((w) => w.includes("turn queue full")), "overflow is dropped with a warning");
	release();
	await waitFor(() => followups.length === 2);
	assert.deepEqual(followups, ["one", "two"], "dropped message never reaches the agent");
});
