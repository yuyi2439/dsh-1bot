// session 模块（src/session.ts）的测试：会话身份（id 格式与路由）与隐藏会话根。
// 回合路径（create/resume、followup、flush）的测试在 test/bridge.test.ts。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SESSIONS_HIDDEN_README,
	chatRoute,
	chatSessionId,
	ensureHiddenSessionsDocs,
	hiddenSessionsRoot,
	sessionToRoute,
} from "../src/session.ts";
import { routeKinds, routeSpecFor } from "../src/adapter/index.ts";
import type { OneBotMessageEvent } from "../src/protocol.ts";

test("chatSessionId formats private and group ids with dash separators", () => {
	assert.equal(chatSessionId({ kind: "private", user_id: 42 }), "onebot-private-42");
	assert.equal(chatSessionId({ kind: "group", group_id: 30003 }), "onebot-group-30003");
});

test("sessionToRoute parses the dash-separated session id", () => {
	assert.deepEqual(sessionToRoute("onebot-private-123456789"), { kind: "private", user_id: 123456789 });
	assert.deepEqual(sessionToRoute("onebot-group-987654321"), { kind: "group", group_id: 987654321 });
	assert.equal(sessionToRoute("onebot:private:123456789"), null, "会话 id 一律用 - 分隔");
	assert.equal(sessionToRoute("web_abc"), null);
	assert.equal(sessionToRoute(undefined as unknown as string), null);
});

test("chatSessionId and sessionToRoute round-trip", () => {
	for (const route of [
		{ kind: "private", user_id: 42 } as const,
		{ kind: "group", group_id: 30003 } as const,
	]) {
		assert.deepEqual(sessionToRoute(chatSessionId(route)), route);
	}
});

test("chatRoute maps a message event to its session id and identity prefix", () => {
	const privateMsg = {
		message_type: "private",
		user_id: 42,
		sender: { user_id: 42, nickname: "Nick", card: "Card" },
	} as unknown as OneBotMessageEvent;
	assert.deepEqual(chatRoute(privateMsg), {
		sessionId: "onebot-private-42",
		prefix: "[好友 Card(42)] ",
	});

	const groupMsg = {
		message_type: "group",
		user_id: 42,
		group_id: 30003,
		sender: { user_id: 42, nickname: "Nick", card: "" },
	} as unknown as OneBotMessageEvent;
	assert.deepEqual(chatRoute(groupMsg), {
		sessionId: "onebot-group-30003",
		prefix: "[群 30003 Nick(42)] ",
	});
});

test("chatRoute returns null for an event that addresses no chat", () => {
	assert.equal(chatRoute({ message_type: "group", user_id: 42 } as unknown as OneBotMessageEvent), null);
	assert.equal(chatRoute({ message_type: "other", user_id: 42 } as unknown as OneBotMessageEvent), null);
});

test("session ids come from the adapter route specs, so a new kind needs no session.ts change", () => {
	for (const kind of routeKinds()) {
		const route = routeSpecFor(kind)!.build(123456789);
		assert.equal(chatSessionId(route), `onebot-${kind}-123456789`);
		assert.deepEqual(sessionToRoute(chatSessionId(route)), route);
	}
	assert.equal(sessionToRoute("onebot-channel-123"), null, "未知种类一律拒绝");
});

test("sessionToRoute rejects malformed ids", () => {
	assert.equal(sessionToRoute(""), null);
	assert.equal(sessionToRoute("onebot"), null);
	assert.equal(sessionToRoute("onebot-private"), null);
	assert.equal(sessionToRoute("onebot-private-abc"), null);
	assert.equal(sessionToRoute(undefined as unknown as string), null);
});

// ── 持久化根 ────────────────────────────────────────────────────────────────

test("ensureHiddenSessionsDocs creates the root and seeds README.md", async () => {
	const root = join(mkdtempSync(join(tmpdir(), "hidden-sessions-")), "sessions-hidden");
	assert.equal(existsSync(root), false);
	await ensureHiddenSessionsDocs(root);
	assert.equal(existsSync(join(root, "README.md")), true);
	assert.match(readFileSync(join(root, "README.md"), "utf8"), /sessions-hidden/);
	assert.match(readFileSync(join(root, "README.md"), "utf8"), /corrupt session log/);
});

test("ensureHiddenSessionsDocs does not overwrite an existing README", async () => {
	const root = join(mkdtempSync(join(tmpdir(), "hidden-sessions-")), "sessions-hidden");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "README.md"), "user notes");
	await ensureHiddenSessionsDocs(root);
	assert.equal(readFileSync(join(root, "README.md"), "utf8"), "user notes");
});

test("hiddenSessionsRoot is under DSH_HOME or the home .dsh", () => {
	assert.ok(hiddenSessionsRoot().endsWith("sessions-hidden"));
});

test("README is exported and non-empty", () => {
	assert.ok(SESSIONS_HIDDEN_README.length > 100);
});
