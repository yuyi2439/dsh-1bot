// profile patch 种子（src/profile-setup.ts）的测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE_TEMPLATE_HEADER, buildPatchTemplate, seedProfilePatch } from "../src/profile-setup.ts";
import type { OnebotConfig } from "../src/config.ts";

const config: OnebotConfig = {
	enabled: true,
	access_token: "",
	prefix: "",
	adapters: [{ type: "qq", config: { url: "ws://127.0.0.1:3001", friend_ids: [123], group_ids: [] } }],
	// 平台无关的路径样本（该字段不参与模板渲染）。
	workspace_root: join(tmpdir(), "onebot-ws"),
	connect_retries: 5,
	connect_retry_delay_secs: 1,
	reply_chunk_size: 4000,
	reply_chunk_delay_ms: 300,
	console_log: true,
	log_local_time: true,
};

test("buildPatchTemplate is fully commented and reflects the config", () => {
	const t = buildPatchTemplate(config);
	assert.ok(t.includes(PROFILE_TEMPLATE_HEADER));
	assert.ok(t.includes("- id: onebot"));
	assert.ok(t.includes("url: 'ws://127.0.0.1:3001'"), "adapter 的连接地址出现在 adapter 段里");
	assert.ok(t.includes("friend_ids: [123]"));
	// 每个通用字段都在模板里现身（含日志时区开关）。
	assert.ok(t.includes(`#     log_local_time: ${config.log_local_time}`));
	// 每个非空行都是注释：模板本身永远不会生效。
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
