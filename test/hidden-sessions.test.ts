// Tests for the hidden sessions root seeding (src/hidden-sessions.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSIONS_HIDDEN_README, ensureHiddenSessionsDocs, hiddenSessionsRoot } from "../src/hidden-sessions.ts";

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
	const root = hiddenSessionsRoot();
	assert.ok(root.endsWith("sessions-hidden"));
});

test("README is exported and non-empty", () => {
	assert.ok(SESSIONS_HIDDEN_README.length > 100);
});
