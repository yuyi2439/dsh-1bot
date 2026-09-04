// Tool-level tests: exercise the registered definitions through a fake
// bridge/client, so the execute bodies (routing, validation, formatting) are
// covered without a live OneBot connection. The fake `api.invoke(method,
// params, opts)` mirrors the onebot.js-backed client: it resolves with the
// response DATA and throws the model-readable formatted error on failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { registerOneBotTools } from "../src/tools.ts";
import { sessionToRoute } from "../src/bridge.ts";
import type { OneBotBridge } from "../src/bridge.ts";

const noExec = {} as ToolRunContext;

/** Minimal bridge surface the tools actually touch. */
interface FakeBridge {
	api: {
		invoke(method: unknown, params?: unknown, opts?: { hint?: string }): Promise<unknown>;
		isConnected?(): boolean;
	};
	config?: { ws_url?: string };
	isAllowedTarget?(target: string): boolean;
	sendTarget?(target: string, text: string): void;
}

/** Register the tools against a fake ctx and return the definitions. */
function collectTools(bridge: FakeBridge): ToolDefinition[] {
	const defs: ToolDefinition[] = [];
	const ctx = { tools: { register: (def: ToolDefinition) => defs.push(def) } };
	registerOneBotTools(ctx as unknown as Context, bridge as unknown as OneBotBridge);
	return defs;
}

test("registers the onebot_* tool family", () => {
	const defs = collectTools({ api: { invoke: async () => ({}) } });
	const names = defs.map((def) => def.name).sort();
	assert.deepEqual(names, [
		"onebot_get_content",
		"onebot_get_msg_history",
		"onebot_send",
		"onebot_status",
		"onebot_voice_text",
	]);
});

test("onebot_send describes the only-delivery contract", () => {
	const def = collectTools({ api: { invoke: async () => ({}) } }).find((d) => d.name === "onebot_send");
	assert.ok(def);
	assert.match(def!.description, /only way to deliver any message/);
	assert.match(def!.description, /call this tool once per part, in order/);
});

test("onebot_send delivers immediately to an allowlisted target", async () => {
	const sent: Array<{ target: string; text: string }> = [];
	const bridge = {
		api: { invoke: async () => ({}) },
		isAllowedTarget: (target: string) => target === "private:42",
		sendTarget: (target: string, text: string) => {
			sent.push({ target, text });
		},
	};
	const send = collectTools(bridge).find((def) => def.name === "onebot_send");
	assert.ok(send);
	const out = (await send!.execute({ target: "private:42", content: "hello" }, noExec)) as { delivered: boolean };
	assert.equal(out.delivered, true);
	assert.deepEqual(sent, [{ target: "private:42", text: "hello" }]);
});

test("onebot_send throws for non-allowlisted targets", async () => {
	const bridge = {
		api: { invoke: async () => ({}) },
		isAllowedTarget: () => false,
		sendTarget: () => {
			throw new Error("must not be called");
		},
	};
	const send = collectTools(bridge).find((def) => def.name === "onebot_send");
	await assert.rejects(send!.execute({ target: "private:99", content: "hi" }, noExec), /not in the allowlist/);
});

test("onebot_get_msg_history routes group vs private history calls", async () => {
	const calls: Array<{ method: unknown; params: any }> = [];
	const bridge = {
		api: {
			invoke: async (method: unknown, params: any) => {
				calls.push({ method, params });
				return { messages: [] };
			},
		},
	};
	const read = collectTools(bridge).find((def) => def.name === "onebot_get_msg_history");
	assert.ok(read);

	const group = (await read!.execute({ target: "group:30003", limit: 5 }, noExec)) as { target: string };
	assert.equal(calls[0].method, "get_group_msg_history");
	assert.equal(calls[0].params.group_id, 30003);
	assert.equal(calls[0].params.count, 5);
	assert.equal(group.target, "group:30003");

	const priv = (await read!.execute({ target: "private:42" }, noExec)) as { target: string };
	assert.equal(calls[1].method, "get_friend_msg_history");
	assert.equal(calls[1].params.user_id, 42);
	assert.equal(calls[1].params.count, 20);
	assert.equal(priv.target, "private:42");
});

test("onebot_get_msg_history rejects invalid targets and limits without calling", async () => {
	let called = false;
	const bridge = {
		api: {
			invoke: async () => {
				called = true;
				return { messages: [] };
			},
		},
	};
	const read = collectTools(bridge).find((def) => def.name === "onebot_get_msg_history");
	await assert.rejects(read!.execute({ target: "bogus" }, noExec), /target must be/);
	await assert.rejects(read!.execute({ target: "group:30003", limit: 200 }, noExec), /limit/);
	await assert.rejects(read!.execute({ target: "group:30003", limit: 0 }, noExec), /limit/);
	assert.equal(called, false);
});

test("onebot_get_msg_history formats returned messages", async () => {
	const bridge = {
		api: {
			invoke: async () => ({
				messages: [
					{
						message_id: 1,
						user_id: 42,
						time: 0,
						message: "hi",
						sender: { user_id: 42, nickname: "A" },
					},
				],
			}),
		},
	};
	const read = collectTools(bridge).find((def) => def.name === "onebot_get_msg_history");
	const out = (await read!.execute({ target: "private:42" }, noExec)) as { text: string };
	assert.ok(out.text.includes("A(42) 消息ID:1: hi"));
});

test("onebot_get_msg_history surfaces the client's formatted error with the hint", async () => {
	const bridge = {
		api: {
			invoke: async (method: unknown, _params: unknown, opts?: { hint?: string }) => {
				// Mirror the onebot.js-backed client: failures arrive as
				// formatted errors, with the tool's hint appended.
				throw new Error(
					`${method} failed: status=failed retcode=1404, detail="不支持该接口"${opts?.hint ? ` — ${opts.hint}` : ""}`,
				);
			},
		},
	};
	const read = collectTools(bridge).find((def) => def.name === "onebot_get_msg_history");
	await assert.rejects(
		read!.execute({ target: "private:42" }, noExec),
		/get_friend_msg_history failed: status=failed retcode=1404, detail="不支持该接口".*NapCat\/go-cqhttp extension/,
	);
});

test("onebot_get_msg_history returns the no-messages notice for an empty chat", async () => {
	let called = 0;
	const bridge = {
		api: {
			invoke: async () => {
				called += 1;
				return { messages: [] };
			},
		},
	};
	const read = collectTools(bridge).find((def) => def.name === "onebot_get_msg_history");
	const out = (await read!.execute({ target: "private:42" }, noExec)) as { text: string };
	assert.equal(called, 1);
	assert.equal(out.text, "chat private:42 has no readable recent messages");
});

test("sessionToRoute parses the dash-separated session id", () => {
	assert.deepEqual(sessionToRoute("onebot-private-2961354039"), { kind: "private", user_id: 2961354039 });
	assert.deepEqual(sessionToRoute("onebot-group-551947633"), { kind: "group", group_id: 551947633 });
	assert.equal(sessionToRoute("onebot:private:2961354039"), null); // old colon format is gone
	assert.equal(sessionToRoute("web_abc"), null);
	assert.equal(sessionToRoute(undefined as unknown as string), null);
});

test("onebot_status reports connection state without throwing", async () => {
	const bridge = {
		api: {
			connected: false,
			invoke: async () => {
				throw new Error("must not be called when disconnected");
			},
		},
		config: { ws_url: "ws://127.0.0.1:3001" },
	};
	const status = collectTools(bridge).find((def) => def.name === "onebot_status");
	const out = (await status!.execute({}, noExec)) as Record<string, unknown>;
	assert.deepEqual(out, {
		user_id: 0,
		nickname: "",
		connected: false,
		ws_url: "ws://127.0.0.1:3001",
	});
});
