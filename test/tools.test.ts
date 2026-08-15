// Tool-level tests: exercise the registered definitions through a fake
// bridge/client, so the execute bodies (routing, validation, formatting) are
// covered without a live OneBot connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { registerOneBotTools } from "../src/tools.ts";
import type { OneBotBridge } from "../src/bridge.ts";
import type { OneBotAction } from "../src/protocol.ts";

const noExec = {} as ToolRunContext;

/** Minimal bridge surface the tools actually touch. */
interface FakeBridge {
	api: { call(action: unknown): Promise<unknown>; isConnected?(): boolean };
	config?: { ws_url?: string };
	isAllowedTarget?(target: string): boolean;
	sendTarget?(target: string, text: string): void;
	sendTargetApproved?(target: string, text: string): void;
	requestApproval?(req: unknown): Promise<unknown>;
}

/** Register the tools against a fake ctx and return the definitions. */
function collectTools(bridge: FakeBridge): ToolDefinition[] {
	const defs: ToolDefinition[] = [];
	const ctx = { tools: { register: (def: ToolDefinition) => defs.push(def) } };
	registerOneBotTools(ctx as unknown as Context, bridge as unknown as OneBotBridge);
	return defs;
}

test("registers the onebot_* tool family", () => {
	const defs = collectTools({ api: { call: async () => ({}) } });
	const names = defs.map((def) => def.name).sort();
	assert.deepEqual(names, [
		"onebot_get_msg",
		"onebot_read",
		"onebot_send",
		"onebot_status",
		"onebot_voice_text",
	]);
});

test("onebot_read routes group vs private history actions", async () => {
	const calls: OneBotAction[] = [];
	const bridge = {
		api: {
			call: async (action: unknown) => {
				calls.push(action as OneBotAction);
				return { retcode: 0, data: { messages: [] } };
			},
		},
	};
	const read = collectTools(bridge).find((def) => def.name === "onebot_read");
	assert.ok(read);

	const group = (await read!.execute({ target: "group:30003", limit: 5 }, noExec)) as { target: string };
	assert.equal(calls[0].action, "get_group_msg_history");
	assert.equal(calls[0].params.group_id, 30003);
	assert.equal(calls[0].params.count, 5);
	assert.equal(group.target, "group:30003");

	const priv = (await read!.execute({ target: "private:42" }, noExec)) as { target: string };
	assert.equal(calls[1].action, "get_friend_msg_history");
	assert.equal(calls[1].params.user_id, 42);
	assert.equal(calls[1].params.count, 20);
	assert.equal(priv.target, "private:42");
});

test("onebot_read rejects invalid targets and limits without calling", async () => {
	let called = false;
	const bridge = {
		api: {
			call: async () => {
				called = true;
				return { retcode: 0, data: { messages: [] } };
			},
		},
	};
	const read = collectTools(bridge).find((def) => def.name === "onebot_read");
	await assert.rejects(read!.execute({ target: "bogus" }, noExec), /target must be/);
	await assert.rejects(read!.execute({ target: "group:30003", limit: 200 }, noExec), /limit/);
	await assert.rejects(read!.execute({ target: "group:30003", limit: 0 }, noExec), /limit/);
	assert.equal(called, false);
});

test("onebot_read formats returned messages", async () => {
	const bridge = {
		api: {
			call: async () => ({
				retcode: 0,
				data: {
					messages: [
						{
							message_id: 1,
							user_id: 42,
							time: 0,
							message: "hi",
							sender: { user_id: 42, nickname: "A" },
						},
					],
				},
			}),
		},
	};
	const read = collectTools(bridge).find((def) => def.name === "onebot_read");
	const out = (await read!.execute({ target: "private:42" }, noExec)) as { text: string };
	assert.ok(out.text.includes("A(42) 消息ID:1: hi"));
});

test("onebot_read errors directly when get_friend_msg_history is unsupported", async () => {
	const bridge = {
		api: {
			call: async () => ({
				status: "failed",
				retcode: 1404,
				data: { message: "不支持该接口" },
			}),
		},
	};
	const read = collectTools(bridge).find((def) => def.name === "onebot_read");
	await assert.rejects(
		read!.execute({ target: "private:42" }, noExec),
		/get_friend_msg_history failed: status=failed retcode=1404, detail="不支持该接口".*NapCat\/go-cqhttp extension/,
	);
});

test("onebot_read accepts a response without retcode when status is ok", async () => {
	let called = 0;
	const bridge = {
		api: {
			call: async () => {
				called += 1;
				return { status: "ok", data: { messages: [] } };
			},
		},
	};
	const read = collectTools(bridge).find((def) => def.name === "onebot_read");
	const out = (await read!.execute({ target: "private:42" }, noExec)) as { text: string };
	assert.equal(called, 1);
	assert.equal(out.text, "chat private:42 has no readable recent messages");
});

test("onebot_read stays strict when retcode is missing and status is not ok", async () => {
	const bridge = {
		api: {
			call: async () => ({ data: {} }),
		},
	};
	const read = collectTools(bridge).find((def) => def.name === "onebot_read");
	await assert.rejects(read!.execute({ target: "group:1" }, noExec), /get_group_msg_history failed/);
});

test("onebot_status reports connection state without throwing", async () => {
	const bridge = {
		api: {
			isConnected: () => false,
			call: async () => {
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
