// adapter 注册表与解析辅助函数：其它模块只通过这里拿路由接线方式与白名单，
// 不认识任何具体平台。新增一种 adapter = 加实现文件 + 注册进下面的实现表。
import z from "@deepseek-ai/schemastery";
import type { Adapter, ChatRoute, RouteAction, RouteKind, RouteSpec } from "./types.ts";
import { qqAdapter } from "./qq.ts";

export type { Adapter, ChatRoute, RouteAction, RouteKind, RouteSpec } from "./types.ts";

/** 已实现的全部 adapter（唯一的实现清单）。 */
const ADAPTERS: Adapter[] = [qqAdapter];

/** 配置里一条 adapter 记录：类型名 + 它自己的配置。 */
export interface AdapterEntry {
	type: string;
	config: Record<string, unknown>;
}

/** 按类型名取 adapter 实现；不认识时返回 undefined。 */
export function adapterOf(type: string): Adapter | undefined {
	return ADAPTERS.find((adapter) => adapter.type === type);
}

/** 配置里已启用的 adapter 记录。 */
export function enabledAdapters(config: { adapters: AdapterEntry[] }): Array<{ adapter: Adapter; config: Record<string, unknown> }> {
	const enabled: Array<{ adapter: Adapter; config: Record<string, unknown> }> = [];
	for (const entry of config.adapters) {
		const adapter = adapterOf(entry.type);
		if (adapter) enabled.push({ adapter, config: entry.config ?? {} });
	}
	return enabled;
}

/**
 * `adapters` 字段的 schema：按各 adapter 自己的 schema 校验其 `config`，未知
 * `type` 会被拒绝。输出类型显式标注，使推导出的配置类型保持可命名。
 */
export const AdaptersSchema: z<AdapterEntry[]> = z.array(
	z.union(ADAPTERS.map((adapter) => z.object({ type: z.const(adapter.type), config: adapter.config }))),
);

/** 各 adapter 声明汇总出的路由种类 → 接线方式总表。 */
const ROUTES: Record<string, RouteSpec> = Object.assign({}, ...ADAPTERS.map((adapter) => adapter.routes));

/** 取某个路由种类的接线方式；不认识时返回 undefined。 */
export function routeSpecFor(kind: string): RouteSpec | undefined {
	return ROUTES[kind];
}

/** 已接入的全部路由种类名。 */
export function routeKinds(): string[] {
	return Object.keys(ROUTES);
}

/** 已启用 adapter 提供的路由种类名。 */
export function enabledRouteKinds(config: { adapters: AdapterEntry[] }): string[] {
	return enabledAdapters(config).flatMap(({ adapter }) => Object.keys(adapter.routes));
}

/** 取某条 route 的目标号（字段名由该种类的接线方式决定）。 */
export function routeId(route: ChatRoute): number {
	return Number((route as unknown as Record<string, unknown>)[routeSpecFor(route.kind)!.idField]);
}

/** 取某条 route 的目标字符串（`<kind>:<id>`，与 {@link parseTarget} 互逆）。 */
export function routeTarget(route: ChatRoute): string {
	return `${route.kind}:${routeId(route)}`;
}

/** 解析目标字符串（`<kind>:<id>`）；种类不认识或号码不合法时返回 null。 */
export function parseTarget(target: string | null | undefined): ChatRoute | null {
	const [kind, id] = String(target ?? "").split(":");
	return routeSpecFor(kind)?.parse(id) ?? null;
}

/** 会话 id 前缀。 */
const SESSION_ID_PREFIX = "onebot";

/**
 * 由会话 id 反解出回复路由。格式为 `<前缀>-<kind>-<id>`：id 里可能含 `-`，
 * 所以只按前两段切分，其余整段交给该种类的 `parse` 校验。
 */
export function sessionToRoute(sessionId: string): ChatRoute | null {
	const parts = String(sessionId ?? "").split("-");
	if (parts.length < 3 || parts[0] !== SESSION_ID_PREFIX) return null;
	return routeSpecFor(parts[1])?.parse(parts.slice(2).join("-")) ?? null;
}

/** 取某条 route 的读历史动作；该种类未声明 `history` 时返回 null。 */
export function routeHistory(route: ChatRoute, limit: number): { action: string; params: Record<string, unknown>; hint?: string } | null {
	const spec = routeSpecFor(route.kind);
	if (!spec?.history) return null;
	return { ...spec.history(routeId(route), limit), hint: spec.historyHint };
}

/**
 * 取某个路由种类的白名单：找到提供该种类的 adapter、按其声明的白名单字段取号码
 * 列表。未启用该种类或未声明字段 = 空数组（谁都不放行）。
 */
export function allowlistForKind(config: { adapters: AdapterEntry[] }, kind: string): readonly number[] {
	for (const { adapter, config: adapterConfig } of enabledAdapters(config)) {
		if (!(kind in adapter.routes)) continue;
		const field = adapter.allowlists[kind];
		const list = field ? adapterConfig[field] : undefined;
		return Array.isArray(list) ? (list as number[]) : [];
	}
	return [];
}

/** 取某条 route 的白名单。 */
export function allowlistFor(config: { adapters: AdapterEntry[] }, route: ChatRoute): readonly number[] {
	return allowlistForKind(config, route.kind);
}

/** 取要连接的实现端地址；没有任何 adapter 声明时返回 null（调用方按致命错误处理）。 */
export function transportUrl(config: { adapters: AdapterEntry[] }): string | null {
	for (const { adapter, config: adapterConfig } of enabledAdapters(config)) {
		if (!adapter.transportUrl) continue;
		const value = adapterConfig[adapter.transportUrl];
		if (typeof value === "string" && value !== "") return value;
	}
	return null;
}
