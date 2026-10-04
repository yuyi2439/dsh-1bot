// 进程级单例锁（src/singleton.ts）的测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingletonLock } from "../src/singleton.ts";

function tempLock(): string {
	const dir = mkdtempSync(join(tmpdir(), "onebot-lock-"));
	return join(dir, ".onebot.lock");
}

test("singleton lock: second acquisition is refused, release allows retake", async () => {
	const lock = tempLock();
	const release = await acquireSingletonLock(lock);
	assert.ok(release, "first acquisition succeeds");

	const second = await acquireSingletonLock(lock);
	assert.equal(second, null, "second live instance is refused");

	await release!();
	const third = await acquireSingletonLock(lock);
	assert.ok(third, "retake after release succeeds");
	await third!();
	assert.equal(existsSync(lock), false, "lock removed on release");
});

test("singleton lock: a stale lock (dead pid) is taken over", async () => {
	const lock = tempLock();
	writeFileSync(lock, "999999999"); // 一个不可能存活的 pid
	const release = await acquireSingletonLock(lock);
	assert.ok(release, "stale lock is taken over");
	await release!();
	assert.equal(existsSync(lock), false);
});
