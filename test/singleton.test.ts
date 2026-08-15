// Tests for the process-level singleton lock (src/singleton.ts).
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
	writeFileSync(lock, "999999999"); // a pid that cannot be alive
	const release = await acquireSingletonLock(lock);
	assert.ok(release, "stale lock is taken over");
	await release!();
	assert.equal(existsSync(lock), false);
});
