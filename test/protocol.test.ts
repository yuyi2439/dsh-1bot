// Unit tests for the dependency-free protocol helpers (ported from the
// nota-onebot types test suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	chunkText,
	formatHistory,
	identity,
	messageToText,
	parseApproval,
	parseMessageId,
	parseTarget,
} from "../src/protocol.ts";

test("messageToText keeps text segments and passes plain strings through", () => {
	assert.equal(messageToText("@someone 你好"), "@someone 你好");
	const message = [
		{ type: "text", data: { text: "hello " } },
		{ type: "text", data: { text: "world" } },
	];
	assert.equal(messageToText(message), "hello world");
});

test("messageToText default renders all data as key=value with the message id", () => {
	const image = [{ type: "image", data: { file: "a.png", url: "https://x" } }];
	assert.equal(messageToText(image, "77"), "[image msg id:77 file=a.png url=https://x]");
	assert.equal(messageToText(image), "[image file=a.png url=https://x]");
});

test("messageToText renders every non-text segment type via the default renderer", () => {
	const message = [
		{ type: "face", data: { id: 1 } },
		{ type: "at", data: { qq: "10001" } },
		{ type: "some_future_type", data: { a: "1", b: 2 } },
	];
	assert.equal(messageToText(message, "77"), "[face msg id:77 id=1][at msg id:77 qq=10001][some_future_type msg id:77 a=1 b=2]");
	assert.equal(messageToText(message), "[face id=1][at qq=10001][some_future_type a=1 b=2]");
});

test("messageToText handles mixed text and media segments", () => {
	const mixed = [
		{ type: "text", data: { text: "收到 " } },
		{ type: "record", data: { file: "voice.amr" } },
	];
	assert.equal(messageToText(mixed, "42"), "收到 [record msg id:42 file=voice.amr]");
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
