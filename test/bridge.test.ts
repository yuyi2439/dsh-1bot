// Bridge-level tests: exercise the outbound path (sendReply) through a fake
// client, so sending/chunking/validation are covered without a live OneBot
// connection or a full agent run.
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
	approval_timeout_secs: 300,
	console_log: true,
};

function makeBridge(send: (method: string, params: unknown) => Promise<unknown>): OneBotBridge {
	const client = { send } as unknown as ConstructorParameters<typeof OneBotBridge>[0]["client"];
	return new OneBotBridge({
		ctx: {} as Context,
		config,
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

test("sendReply chunks long text at the configured size", () => {
	const calls: Array<{ method: string; params: any }> = [];
	const bridge = makeBridge((method, params) => {
		calls.push({ method, params });
		return Promise.resolve();
	});
	const longText = "x".repeat(5000);
	bridge.sendReply({ kind: "group", group_id: 30003 }, longText);
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
