// 桥接层测试：出站（sendReply / sendTarget / 白名单）、对外服务表面，以及回合
// 路径（入站过滤、create vs resume、followup、flush）。用一个真实的 cordis
// Context 装假服务，不连真实 OneBot。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { OneBotBridge } from "../src/bridge.ts";
import type { OnebotConfig } from "../src/config.ts";
import { publicService } from "../src/service.ts";

/** 一个全新的临时工作区根（会走到 agent 创建的测试必须用它）。 */
function tempWorkspaceRoot(): string {
	return join(mkdtempSync(join(tmpdir(), "onebot-bridge-ws-")), "root");
}

const config: OnebotConfig = {
	enabled: true,
	access_token: "",
	prefix: "",
	adapters: [{ type: "qq", config: { url: "ws://127.0.0.1:3001", friend_ids: [42], group_ids: [30003] } }],
	workspace_root: tempWorkspaceRoot(),
	connect_retries: 5,
	connect_retry_delay_secs: 1,
	reply_chunk_size: 4000,
	reply_chunk_delay_ms: 1,
	console_log: true,
	log_local_time: true,
};

/** 记录 followup 文本的假 agent。 */
interface FakeAgentFixture {
	messages: string[];
	agent: {
		session: { id: string };
		followup(msg: { content: Array<{ text: string }> }): void;
		whenIdle(): Promise<void>;
	};
}

function fakeAgent(sessionId = "fake"): FakeAgentFixture {
	const messages: string[] = [];
	return {
		messages,
		agent: {
			session: { id: sessionId },
			followup: (msg) => {
				messages.push(msg.content[0].text);
			},
			whenIdle: async () => {},
		},
	};
}

/**
 * 一个可观察的桥接层：`calls` 记录 create/resume/get，`flushed` 记录 flush。
 * `durable` 表示磁盘上是否已有该会话的日志；`live` 表示 `agents.get` 命中的活 agent。
 */
function makeBridge(
	send: (method: string, params: unknown) => Promise<unknown>,
	{ overrides = {}, durable = false, live, settledModel = false }: {
		overrides?: Partial<OnebotConfig>;
		durable?: boolean;
		live?: ReturnType<typeof fakeAgent>["agent"];
		/** 是否装上假的 agentDefaultModel（装上后会走 installModelSelection 的 setup）。 */
		settledModel?: boolean;
	} = {},
) {
	const calls: Array<{ kind: string; sessionId: string }> = [];
	const flushed: string[] = [];
	const built = fakeAgent();
	const messages: string[] = built.messages;
	// dsh 的 AgentRegistry 会记住活 agent，所以 create/resume 之后 get 能命中。
	const registry = new Map<string, ReturnType<typeof fakeAgent>["agent"]>();
	if (live) registry.set("onebot-group-30003", live);
	const ctx = new Context();
	ctx.provide("agents", {
		get: (id: string) => {
			calls.push({ kind: "get", sessionId: id });
			return registry.get(id);
		},
		create: async (opts: { sessionId: string }) => {
			calls.push({ kind: "create", sessionId: opts.sessionId });
			registry.set(opts.sessionId, built.agent);
			return { agent: built.agent };
		},
		resume: async (opts: { resumeSessionId: string }) => {
			calls.push({ kind: "resume", sessionId: opts.resumeSessionId });
			registry.set(opts.resumeSessionId, built.agent);
			return { agent: built.agent };
		},
	});
	ctx.provide("sessions", {
		flush: async (session: { id: string }) => {
			flushed.push(session.id);
			return true;
		},
	});
	ctx.provide("sessionPersistence", { stat: async () => (durable ? { header: { id: "x" } } : undefined) });
	if (settledModel) ctx.provide("agentDefaultModel", { currentSelection: () => ({ provider: "fake", model: "fake-model" }) });
	const client = { send } as unknown as ConstructorParameters<typeof OneBotBridge>[2];
	const bridge = new OneBotBridge(ctx, { ...config, ...overrides }, client);
	return { bridge, calls, messages, flushed };
}

/** 一条入站群消息（发送者 7，目标群 30003）。 */
function groupMessage(text: string, overrides: Record<string, unknown> = {}) {
	return {
		post_type: "message",
		message_type: "group",
		message_id: 1,
		user_id: 7,
		self_id: 10000,
		group_id: 30003,
		message: [{ type: "text", data: { text } }],
		...overrides,
	};
}

/** 等到断言成立（每 5ms 轮询一次）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// ── 出站 ────────────────────────────────────────────────────────────────────

test("sendReply sends every call, routing group vs private", () => {
	const calls: Array<{ method: string; params: any }> = [];
	const { bridge } = makeBridge((method, params) => {
		calls.push({ method, params });
		return Promise.resolve();
	});
	bridge.sendReply({ kind: "group", group_id: 30003 }, "hello");
	bridge.sendReply({ kind: "group", group_id: 30003 }, "hello");
	bridge.sendReply({ kind: "private", user_id: 42 }, "hello");
	assert.equal(calls.length, 3, "every call is sent as-is (no dedupe)");
	assert.equal(calls[0].method, "send_group_msg");
	assert.equal(calls[0].params.group_id, 30003);
	assert.equal(calls[2].method, "send_private_msg");
	assert.equal(calls[2].params.user_id, 42);
});

test("sendReply chunks long text at the configured size, pacing between chunks", async () => {
	const calls: Array<{ method: string; params: any }> = [];
	const { bridge } = makeBridge((method, params) => {
		calls.push({ method, params });
		return Promise.resolve();
	});
	const longText = "x".repeat(5000);
	bridge.sendReply({ kind: "group", group_id: 30003 }, longText);
	await waitFor(() => calls.length === 2);
	assert.equal(calls.length, 2, "5000 chars at a 4000 cap is two chunks");
	const texts = calls.map((c) => (c.params.message as Array<{ data: { text: string } }>)[0].data.text);
	assert.equal(texts[0].length, 4000);
	assert.equal(texts[1].length, 1000);
});

test("sendTarget throws for invalid or non-allowlisted targets", () => {
	const { bridge } = makeBridge(() => Promise.resolve());
	assert.throws(() => bridge.sendTarget("bogus", "x"), /invalid target/);
	assert.throws(() => bridge.sendTarget("private:999", "x"), /not in the allowlist/);
});

test("the allowlist is resolved per route kind, not hardcoded to private/group", () => {
	const { bridge } = makeBridge(() => Promise.resolve());
	assert.equal(bridge.isAllowedTarget("private:42"), true);
	assert.equal(bridge.isAllowedTarget("group:30003"), true);
	assert.equal(bridge.isAllowedTarget("private:30003"), false, "a group id is not a private allowlist entry");
	assert.equal(bridge.isAllowedTarget("group:42"), false, "a friend id is not a group allowlist entry");
});

// ── 对外服务表面 ────────────────────────────────────────────────────────────

test("the public service exposes the client and the send helpers", () => {
	const { bridge } = makeBridge(() => Promise.resolve());
	const service = publicService(bridge);
	assert.equal(typeof service.client.send, "function", "client 就是 bridge 的 client");
	assert.equal(service.isAllowedTarget("private:42"), true);
	assert.equal(service.isAllowedTarget("private:999"), false);
	assert.throws(() => service.send("private:999", "x"), /not in the allowlist/);
});

test("the public service sends through the bridge", () => {
	const calls: Array<{ method: string; params: any }> = [];
	const { bridge } = makeBridge((method, params) => {
		calls.push({ method, params });
		return Promise.resolve();
	});
	publicService(bridge).sendReply({ kind: "group", group_id: 30003 }, "hello");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].method, "send_group_msg");
});

// ── 回合路径 ────────────────────────────────────────────────────────────────

test("an inbound message creates the agent once and delivers the text", async () => {
	const { bridge, calls, messages, flushed } = makeBridge(() => Promise.resolve());
	await bridge.onMessageEvent(groupMessage("hello") as never);
	await bridge.onMessageEvent(groupMessage("again", { message_id: 2 }) as never);
	assert.deepEqual(
		calls.filter((c) => c.kind === "create").length,
		1,
		"only the first message creates; the second reuses the live agent",
	);
	assert.equal(messages.length, 2);
	assert.ok(messages[0].startsWith("[群 30003 "), `identity prefix missing: ${messages[0]}`);
	assert.ok(messages[0].endsWith("hello"));
	assert.deepEqual(flushed, ["fake", "fake"], "each turn flushes the session");
});

test("a created agent is built with the configured model selection", async () => {
	const { bridge, calls } = makeBridge(() => Promise.resolve(), { settledModel: true });
	await bridge.onMessageEvent(groupMessage("hello") as never);
	assert.deepEqual(
		calls.filter((c) => c.kind !== "get").map((c) => c.kind),
		["create"],
	);
});

test("an existing durable log is resumed instead of created", async () => {
	const { bridge, calls, messages } = makeBridge(() => Promise.resolve(), { durable: true });
	await bridge.onMessageEvent(groupMessage("after restart") as never);
	assert.deepEqual(
		calls.filter((c) => c.kind !== "get").map((c) => c.kind),
		["resume"],
	);
	assert.equal(messages.length, 1);
});

test("a live agent is reused without create or resume", async () => {
	const live = fakeAgent("onebot-group-30003");
	const { bridge, calls } = makeBridge(() => Promise.resolve(), { live: live.agent });
	await bridge.onMessageEvent(groupMessage("hi") as never);
	assert.deepEqual(calls.filter((c) => c.kind !== "get"), [], "no create/resume when the agent is live");
	assert.equal(live.messages.length, 1, "the live agent receives the turn");
});

test("own messages and non-allowlisted chats never reach an agent", async () => {
	const { bridge, calls, messages } = makeBridge(() => Promise.resolve());
	await bridge.onMessageEvent(groupMessage("me", { user_id: 10000 }) as never);
	await bridge.onMessageEvent(groupMessage("stranger", { group_id: 999 }) as never);
	assert.deepEqual(calls, [], "the gates run before any agent work");
	assert.equal(messages.length, 0);
});

test("the prefix gate drops messages that do not start with it, and strips it", async () => {
	const { bridge, messages } = makeBridge(() => Promise.resolve(), { overrides: { prefix: "!" } });
	await bridge.onMessageEvent(groupMessage("no prefix") as never);
	assert.equal(messages.length, 0, "message without the prefix is dropped");
	await bridge.onMessageEvent(groupMessage("!go", { message_id: 2 }) as never);
	assert.equal(messages.length, 1);
	assert.ok(messages[0].endsWith("go"), `prefix not stripped: ${messages[0]}`);
});
