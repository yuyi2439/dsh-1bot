// Unit tests for the dependency-free protocol helpers (ported from the
// nota-onebot types.rs test suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	chunkText,
	formatHistory,
	getFriendMsgHistory,
	identity,
	parseApproval,
	parseMessageId,
	parseTarget,
	toText,
	toTextWithId,
} from "../src/protocol.ts";

test("toText flattens segment arrays with placeholders", () => {
	const message = [
		{ type: "text", data: { text: "hello " } },
		{ type: "face", data: { id: "1" } },
		{ type: "text", data: { text: " world" } },
	];
	assert.equal(toText(message), "hello [face] world");
});

test("toText passes plain strings through", () => {
	assert.equal(toText("@someone 你好"), "@someone 你好");
});

test("toTextWithId renders non-text segments with the message id", () => {
	const voice = [{ type: "record", data: { file: "voice.amr" } }];
	assert.equal(toTextWithId(voice, "99"), "[record msg id:99]");

	const mixed = [
		{ type: "text", data: { text: "收到 " } },
		{ type: "record", data: {} },
	];
	assert.equal(toTextWithId(mixed, "42"), "收到 [record msg id:42]");
});

test("toTextWithId renders every non-text segment type uniformly", () => {
	const message = [
		{ type: "image", data: {} },
		{ type: "face", data: { id: 1 } },
		{ type: "video", data: {} },
		{ type: "at", data: { qq: "10001" } },
		{ type: "forward", data: {} },
		{ type: "some_future_type", data: {} },
	];
	assert.equal(
		toTextWithId(message, "77"),
		"[image msg id:77][face msg id:77][video msg id:77][at msg id:77][forward msg id:77][some_future_type msg id:77]",
	);
	assert.equal(toText(message), "[image][face][video][at][forward][some_future_type]");
});

test("identity prefers card over nickname, falls back to the QQ number", () => {
	assert.equal(identity({ user_id: 10001, nickname: "Alice" }, 10001), "Alice(10001)");
	assert.equal(
		identity({ user_id: 10001, nickname: "Alice", card: "A" }, 10001),
		"A(10001)",
	);
	assert.equal(identity(undefined, 42), "42");
	assert.equal(identity(undefined, undefined), "");
});

test("chunkText splits long text at the cap", () => {
	const text = "a".repeat(9000);
	const chunks = chunkText(text, 4000);
	assert.equal(chunks.length, 3);
	assert.deepEqual(chunks.map((c) => c.length), [4000, 4000, 1000]);
	assert.equal(chunks.join(""), text);
	assert.deepEqual(chunkText("short", 4000), ["short"]);
	assert.deepEqual(chunkText("a".repeat(10), 0), ["a".repeat(10)]);
});

test("parseApproval understands 同意/批准/拒绝 with optional queue positions", () => {
	assert.deepEqual(parseApproval("同意"), { approved: true, seq: null });
	assert.deepEqual(parseApproval(" 同意 "), { approved: true, seq: null });
	assert.deepEqual(parseApproval("同意2"), { approved: true, seq: 2 });
	assert.deepEqual(parseApproval("批准"), { approved: true, seq: null });
	assert.deepEqual(parseApproval("拒绝"), { approved: false, seq: null });
	assert.deepEqual(parseApproval("拒绝3"), { approved: false, seq: 3 });
	assert.equal(parseApproval("你好"), null);
	assert.equal(parseApproval("同意x"), null);
	assert.equal(parseApproval(""), null);
});

test("formatHistory renders readable lines with card/nickname", () => {
	const messages = [
		{
			message_id: 1,
			user_id: 10001,
			time: 1700000000,
			message: [{ type: "text", data: { text: "hello" } }],
			sender: { user_id: 10001, nickname: "Alice" },
		},
		{
			message_id: 2,
			user_id: 10002,
			time: 1700000001,
			message: "world",
			sender: { user_id: 10002, nickname: "Bob", card: "B" },
		},
	];
	const text = formatHistory(messages);
	assert.ok(text.includes("Alice(10001) 消息ID:1: hello"));
	assert.ok(text.includes("B(10002) 消息ID:2: world"));
	assert.equal(text.split("\n").length, 2);
});

test("formatHistory skips empty messages", () => {
	const text = formatHistory([
		{ message_id: 1, user_id: 1, time: 0, message: [] },
		{ message_id: 2, user_id: 2, time: 0, message: "" },
	]);
	assert.equal(text, "");
});

test("parseMessageId coerces numbers and strings", () => {
	assert.equal(parseMessageId(1234567890), "1234567890");
	assert.equal(parseMessageId("99"), "99");
	assert.equal(parseMessageId(undefined), "");
});

test("parseTarget parses private and group chat references", () => {
	assert.deepEqual(parseTarget("private:2961354039"), { kind: "private", user_id: 2961354039 });
	assert.deepEqual(parseTarget("group:551947633"), { kind: "group", group_id: 551947633 });
	assert.equal(parseTarget("bogus"), null);
	assert.equal(parseTarget("private:abc"), null);
	assert.equal(parseTarget("group:"), null);
	assert.equal(parseTarget(undefined), null);
});

test("getFriendMsgHistory serializes the NapCat extended action", () => {
	const action = getFriendMsgHistory(10001, 20);
	assert.equal(action.action, "get_friend_msg_history");
	assert.equal(action.params.user_id, 10001);
	assert.equal(action.params.message_seq, 0);
	assert.equal(action.params.count, 20);
	assert.equal(typeof action.echo, "string");
});
