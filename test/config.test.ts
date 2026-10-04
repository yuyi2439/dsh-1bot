// config 模块（src/config.ts）的测试：通用字段的 schema 默认值、`DEFAULTS`，
// 以及每聊天工作区的推导。DEFAULTS 与 schema 的一致性检查是本模块"唯一真源"的
// 回归护栏 —— 种子模板必须和 loader 实际解析出的结果一致。
//
// 平台相关字段（各 adapter 自己的配置）的测试见 test/adapter.test.ts。
//
// 路径样本一律由 `node:os` 的临时目录拼出，断言只验证"怎么拼"，不验证"拼在哪个
// 系统上" —— 这些测试在任何操作系统上跑都必须一样。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, DEFAULTS, chatWorkspace, defaultWorkspaceRoot } from "../src/config.ts";
import type { OnebotConfig } from "../src/config.ts";

/**
 * 像 loader 那样解析一份部分配置。`Config` 的调用签名收的是"输入"类型（每个
 * 字段都可省略），所以这里的 Partial 就是调用方真实会传的形状。
 */
function resolve(partial: Partial<OnebotConfig> = {}): OnebotConfig {
	return Config(partial as OnebotConfig);
}

test("the schema resolves every generic field, so the result is complete", () => {
	// `workspace_root` / `adapters` 也有默认值，所以不传时解析结果依然完整 ——
	// 调用方不需要任何 `?? 默认值` 兜底。
	const resolved = resolve();
	assert.deepEqual(resolved, {
		...DEFAULTS,
		workspace_root: DEFAULTS.workspace_root,
		adapters: DEFAULTS.adapters,
	});
});

test("workspace_root defaults to a stable non-empty path", () => {
	// 默认值由 `$DSH_HOME` 推导；它必须与启动目录无关（见下一条测试）。
	const root = resolve().workspace_root;
	assert.equal(root, DEFAULTS.workspace_root);
	assert.ok(root.endsWith(join("workspaces", "onebot")), `unexpected root: ${root}`);
});

test("a supplied workspace_root overrides the default", () => {
	const supplied = join(tmpdir(), "onebot-ws");
	assert.equal(resolve({ workspace_root: supplied }).workspace_root, supplied);
});

test("adapters default to one enabled adapter, and unknown types are rejected", () => {
	// 默认必须提供一条 adapter 记录（否则开箱即用时谁都不接入）。
	const defaults = resolve().adapters;
	assert.ok(defaults.length >= 1, "默认至少提供一个 adapter");
	for (const entry of defaults) {
		assert.equal(typeof entry.type, "string");
		assert.notEqual(entry.type, "");
	}
	// 未知 type 由 adapter 自己的 schema 分派校验时拒绝。
	assert.throws(() => resolve({ adapters: [{ type: "definitely-not-an-adapter", config: {} }] }));
});

test("a supplied adapter entry keeps its own config, filled out by the adapter's schema", () => {
	// adapter 的 schema 会把它自己声明的默认值补全（这里 `url` 没写），所以
	// 解析结果里该 adapter 的 config 是完整的。
	const resolved = resolve({ adapters: [{ type: "qq", config: { friend_ids: [7], group_ids: [8] } }] });
	assert.equal(resolved.adapters.length, 1);
	assert.equal(resolved.adapters[0].type, "qq");
	assert.deepEqual(resolved.adapters[0].config.friend_ids, [7]);
	assert.deepEqual(resolved.adapters[0].config.group_ids, [8]);
	assert.equal(typeof resolved.adapters[0].config.url, "string", "adapter 的连接地址被默认值补全");
});

test("generic values override their defaults without changing the others", () => {
	const resolved = resolve({ enabled: true, prefix: "!", reply_chunk_size: 100 });
	assert.equal(resolved.enabled, true);
	assert.equal(resolved.prefix, "!");
	assert.equal(resolved.reply_chunk_size, 100);
	assert.equal(resolved.reply_chunk_delay_ms, DEFAULTS.reply_chunk_delay_ms);
	assert.equal(resolved.access_token, DEFAULTS.access_token);
});

test("the log timestamp defaults to local time and can be switched to UTC", () => {
	// 默认本地时间（带偏移）；显式关闭后渲染 UTC（后缀 Z）。
	assert.equal(resolve().log_local_time, true);
	assert.equal(resolve({ log_local_time: false }).log_local_time, false);
});

test("the general config carries no platform or transport fields", () => {
	// 连接地址与白名单属于 adapter 自己的 config；通用字段里不得再出现它们
	// （否则就是两处真源）。
	const resolved = resolve();
	for (const gone of ["ws_url", "url", "mode", "friend_ids", "group_ids"]) {
		assert.equal(gone in resolved, false, `通用配置不应有 ${gone}`);
	}
});

test("resolved adapters are fresh objects, not the DEFAULTS array", () => {
	// schema 在解析时会 clone 默认值，所以调用方可以改动解析结果。
	const resolved = resolve();
	assert.notEqual(resolved.adapters, DEFAULTS.adapters);
	resolved.adapters.push({ type: "qq", config: {} });
	assert.equal(resolve().adapters.length, DEFAULTS.adapters.length, "改动不得泄漏到下一次解析");
});

test("defaultWorkspaceRoot is stable and honours DSH_HOME", () => {
	const previous = process.env.DSH_HOME;
	const home = join(tmpdir(), "onebot-dsh-home");
	try {
		process.env.DSH_HOME = home;
		assert.equal(defaultWorkspaceRoot(), join(home, "workspaces", "onebot"));
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
});

test("defaultWorkspaceRoot never depends on the launch directory", () => {
	// 依赖 cwd 的根会让同一个会话 id 解析到不同的持久化 cwd，从而被
	// session store 拒绝。换到一个新建的目录（必然不等于当前 cwd）再问一次。
	const before = defaultWorkspaceRoot();
	const previousCwd = process.cwd();
	const elsewhere = mkdtempSync(join(tmpdir(), "onebot-cwd-"));
	try {
		process.chdir(elsewhere);
		assert.equal(defaultWorkspaceRoot(), before);
	} finally {
		process.chdir(previousCwd);
	}
});

test("chatWorkspace nests each chat under <root>/chats/<sessionId>", () => {
	const root = join(tmpdir(), "onebot-ws");
	assert.equal(
		chatWorkspace(root, "onebot-group-987654321"),
		join(root, "chats", "onebot-group-987654321"),
	);
});
