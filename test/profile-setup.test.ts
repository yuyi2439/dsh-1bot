// Tests for the profile patch seeding (src/profile-setup.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE_TEMPLATE_HEADER, buildPatchTemplate, seedProfilePatch } from "../src/profile-setup.ts";
import type { OnebotConfig } from "../src/types.ts";

const config: OnebotConfig = {
	enabled: true,
	mode: "ws",
	ws_url: "ws://127.0.0.1:3001",
	access_token: "",
	prefix: "",
	friend_ids: [123],
	group_ids: [],
	connect_retries: 5,
	connect_retry_delay_secs: 1,
	reply_chunk_size: 4000,
	approval_timeout_secs: 300,
	console_log: true,
};

test("buildPatchTemplate is fully commented and reflects the config", () => {
	const t = buildPatchTemplate(config);
	assert.ok(t.includes(PROFILE_TEMPLATE_HEADER));
	assert.ok(t.includes("- id: onebot"));
	assert.ok(t.includes("ws_url: 'ws://127.0.0.1:3001'"));
	assert.ok(t.includes("friend_ids: [123]"));
	// Every non-blank line is a comment: the template itself never activates.
	const lines = t.split("\n").map((l) => l.trim()).filter((l) => l !== "");
	assert.ok(lines.every((l) => l.startsWith("#")), "template stays fully commented");
});

test("seedProfilePatch appends the template when the onebot row is missing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "onebot-patch-"));
	const file = join(dir, "cordis.patch.yml");
	const original = "# Your patch layer for this dsh profile\n[]\n";
	writeFileSync(file, original);
	const seeded = await seedProfilePatch(config, file);
	assert.equal(seeded, true);
	const content = readFileSync(file, "utf8");
	assert.ok(content.startsWith(original), "original content preserved, not replaced");
	assert.ok(content.includes(PROFILE_TEMPLATE_HEADER));
	assert.equal(content.match(/^\[\]$/gm)?.length, 1, "still exactly one [] list");
});

test("seedProfilePatch does nothing when the onebot row exists", async () => {
	const dir = mkdtempSync(join(tmpdir(), "onebot-patch-"));
	const file = join(dir, "cordis.patch.yml");
	const real = "- id: onebot\n  config:\n    enabled: false\n";
	writeFileSync(file, real);
	const seeded = await seedProfilePatch(config, file);
	assert.equal(seeded, false);
	assert.equal(readFileSync(file, "utf8"), real);
});

test("seedProfilePatch appends alongside other content when the row is missing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "onebot-patch-"));
	const file = join(dir, "cordis.patch.yml");
	const other = "- id: timer\n  name: '@deepseek-ai/cordis-plugin-timer'\n";
	writeFileSync(file, other);
	const seeded = await seedProfilePatch(config, file);
	assert.equal(seeded, true);
	const content = readFileSync(file, "utf8");
	assert.ok(content.startsWith(other), "other rows preserved");
	assert.ok(content.includes(PROFILE_TEMPLATE_HEADER));
});

test("seedProfilePatch is idempotent", async () => {
	const dir = mkdtempSync(join(tmpdir(), "onebot-patch-"));
	const file = join(dir, "cordis.patch.yml");
	writeFileSync(file, "[]\n");
	assert.equal(await seedProfilePatch(config, file), true);
	const first = readFileSync(file, "utf8");
	assert.equal(await seedProfilePatch(config, file), false);
	assert.equal(readFileSync(file, "utf8"), first);
});

test("seedProfilePatch skips a missing file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "onebot-patch-"));
	assert.equal(await seedProfilePatch(config, join(dir, "nope.yml")), false);
});
