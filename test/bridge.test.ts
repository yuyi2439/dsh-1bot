// Bridge-level tests: exercise the outbound path (sendReply) through a fake
// client, so sending/chunking/validation are covered without a live OneBot
// connection or a full agent run.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import { OneBotBridge } from "../src/bridge.ts";
import type { OneBotAction } from "../src/protocol.ts";
import type { OnebotConfig } from "../src/types.ts";

/** Minimal client surface the bridge touches on the outbound path. */
interface FakeClient {
	sendAction(action: OneBotAction): void;
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

function makeBridge(sendAction: (action: OneBotAction) => void): OneBotBridge {
	const client = { sendAction } as unknown as ConstructorParameters<typeof OneBotBridge>[0]["client"];
	return new OneBotBridge({
		ctx: {} as Context,
		config,
		client,
		agents: { create: async () => ({}) } as never,
		sessions: { flush: async () => true } as never,
	});
}

test("sendReply sends every call, routing group vs private", () => {
	const actions: OneBotAction[] = [];
	const bridge = makeBridge((action) => actions.push(action));
	bridge.sendReply({ kind: "group", group_id: 30003 }, "hello");
	bridge.sendReply({ kind: "group", group_id: 30003 }, "hello");
	bridge.sendReply({ kind: "private", user_id: 42 }, "hello");
	assert.equal(actions.length, 3, "every call is sent as-is (no dedupe)");
	assert.equal(actions[0].action, "send_group_msg");
	assert.equal(actions[0].params.group_id, 30003);
	assert.equal(actions[1].action, "send_group_msg");
	assert.equal(actions[2].action, "send_private_msg");
	assert.equal(actions[2].params.user_id, 42);
});

test("sendReply chunks long text at the configured size", () => {
	const actions: OneBotAction[] = [];
	const bridge = makeBridge((action) => actions.push(action));
	const longText = "x".repeat(5000);
	bridge.sendReply({ kind: "group", group_id: 30003 }, longText);
	assert.equal(actions.length, 2, "5000 chars at a 4000 cap is two chunks");
	const texts = actions.map((a) => (a.params.message as Array<{ data: { text: string } }>)[0].data.text);
	assert.equal(texts[0].length, 4000);
	assert.equal(texts[1].length, 1000);
});

test("sendTarget throws for invalid or non-allowlisted targets", () => {
	const bridge = makeBridge(() => {});
	assert.throws(() => bridge.sendTarget("bogus", "x"), /invalid target/);
	assert.throws(() => bridge.sendTarget("private:999", "x"), /not in the allowlist/);
});
