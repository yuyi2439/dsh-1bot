// adapter 层（src/adapter/）的测试：注册表解析、目标字符串与会话 id 的往返、
// 白名单按 adapter 配置解析，以及"新增 adapter 无需改动其它模块"这一性质。
//
// 这些断言遍历**全部**已注册的 adapter 与路由种类，因此新增一种 adapter 时它们
// 会自动覆盖到新种类，不需要改测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	adapterOf,
	allowlistForKind,
	enabledAdapters,
	enabledRouteKinds,
	parseTarget,
	routeHistory,
	routeId,
	routeKinds,
	routeSpecFor,
	routeTarget,
} from "../src/adapter/index.ts";

/** 一份只启用 qq、带白名单的配置（结构上等同 OnebotConfig 的相关切片）。 */
const qqConfig = {
	adapters: [{ type: "qq", config: { friend_ids: [42], group_ids: [30003] } }],
};

test("every registered route kind resolves and round-trips through routeTarget", () => {
	for (const kind of routeKinds()) {
		const route = routeSpecFor(kind)!.build(123456789);
		assert.equal(route.kind, kind);
		assert.equal(routeId(route), 123456789);
		assert.equal(routeTarget(route), `${kind}:123456789`);
		assert.deepEqual(parseTarget(routeTarget(route)), route);
	}
});

test("an unknown kind is rejected rather than guessed at", () => {
	assert.equal(parseTarget("channel:123"), null);
	assert.equal(parseTarget("bogus"), null);
	assert.equal(parseTarget("private:abc"), null);
	assert.equal(parseTarget("group:"), null);
	assert.equal(parseTarget(undefined), null);
	assert.equal(routeSpecFor("channel"), undefined);
});

test("parseTarget handles the kinds the built-in adapters declare", () => {
	// 具体取值来自 adapter 声明；这里只固定内置 adapter 的已知行为。
	assert.deepEqual(parseTarget("private:123456789"), { kind: "private", user_id: 123456789 });
	assert.deepEqual(parseTarget("group:987654321"), { kind: "group", group_id: 987654321 });
});

test("routeHistory is optional per kind and uses the kind's own id field", () => {
	for (const kind of routeKinds()) {
		const spec = routeSpecFor(kind)!;
		const history = routeHistory(spec.build(123456789), 20);
		if (!spec.history) {
			assert.equal(history, null, `${kind} 未声明 history`);
			continue;
		}
		assert.ok(history, `${kind} 的 history 必须能解析`);
		assert.equal(history.params[spec.idField], 123456789);
		assert.equal(history.params.count, 20);
	}
});

test("adapterOf resolves only registered types", () => {
	assert.ok(adapterOf("qq"), "内置 adapter 可解析");
	assert.equal(adapterOf("nope"), undefined, "未注册的类型返回 undefined");
});

test("enabledAdapters drops unknown types and keeps the rest", () => {
	const enabled = enabledAdapters({ adapters: [{ type: "nope", config: {} }, ...qqConfig.adapters] });
	assert.deepEqual(
		enabled.map((e) => e.adapter.type),
		["qq"],
	);
	assert.deepEqual(enabledRouteKinds({ adapters: [{ type: "nope", config: {} }] }), [], "未知类型不贡献任何路由种类");
});

test("allowlistForKind reads the field the adapter declares for that kind", () => {
	// 每个种类的白名单都来自它所属 adapter 自己声明的字段，而不是任何全局表。
	for (const kind of enabledRouteKinds(qqConfig)) {
		const list = allowlistForKind(qqConfig, kind);
		assert.ok(Array.isArray(list), `${kind} 必须能取到白名单数组`);
	}
	assert.deepEqual(allowlistForKind(qqConfig, "private"), [42]);
	assert.deepEqual(allowlistForKind(qqConfig, "group"), [30003]);
	// 未启用的种类 / 未启用的 adapter = 空数组（谁都不放行）。
	assert.deepEqual(allowlistForKind({ adapters: [] }, "private"), []);
	assert.deepEqual(allowlistForKind(qqConfig, "channel"), []);
});
