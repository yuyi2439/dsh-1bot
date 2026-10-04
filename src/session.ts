// 会话身份（id 格式与解析，唯一真源）与隐藏会话根目录。
//
// agent / 会话的生命周期、回合队列、持久化全部由 dsh 提供（ctx.agents /
// ctx.sessions / ctx.sessionPersistence），本插件只用它们，不自己再造一层管理器。
// 本插件唯一改动的 dsh 行为是持久化根目录：见 hiddenSessionsRoot。
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { routeId, routeSpecFor, sessionToRoute, type ChatRoute } from "./adapter/index.ts";
import { identity, type OneBotMessageEvent } from "./protocol.ts";

export { sessionToRoute };

/** 会话 id 前缀。 */
const SESSION_ID_PREFIX = "onebot";

/** 会话 id：`onebot-<kind>-<id>`。用 `-` 分隔，JSONL 后端按原样存 id。 */
export function chatSessionId(route: ChatRoute): string {
	return `${SESSION_ID_PREFIX}-${route.kind}-${routeId(route)}`;
}

/** 入站消息 → 会话 id 与身份前缀；路由不出来时返回 null。 */
export function chatRoute(msg: OneBotMessageEvent): { sessionId: string; prefix: string } | null {
	const route = messageRoute(msg);
	if (!route) return null;
	return { sessionId: chatSessionId(route), prefix: `${routeLabel(route, msg)} ` };
}

/** 入站消息 → 路由（种类 + 目标号）；不合法时返回 null。 */
export function messageRoute(msg: OneBotMessageEvent): ChatRoute | null {
	const spec = routeSpecFor(String(msg.message_type ?? ""));
	if (!spec) return null;
	// 带自己 chat id 字段的种类取那个字段，否则用发送者 user_id。
	const id = spec.idField === "user_id" ? msg.user_id : Number((msg as Record<string, unknown>)[spec.idField]);
	return Number.isFinite(id) ? spec.build(id) : null;
}

/** 入站消息的身份前缀标签。 */
function routeLabel(route: ChatRoute, msg: OneBotMessageEvent): string {
	return `[${routeSpecFor(route.kind)!.label(routeId(route))} ${identity(msg.sender, msg.user_id)}]`;
}

/** `$DSH_HOME/sessions-hidden`。 */
export function hiddenSessionsRoot(): string {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "sessions-hidden");
}

/**
 * 隐藏会话目录根部的说明，面向直接打开该目录的人。用独立根目录是为了让 web
 * profile 扫不到这些会话：web UI 一打开可见会话就会 resume，变成同一日志的
 * 第二个写入者。
 */
export const SESSIONS_HIDDEN_README = `# sessions-hidden

This directory holds the durable session logs of the **dsh-1bot** profile
(OneBot / QQ as a dsh UI surface). It is intentionally NOT \`$DSH_HOME/sessions\`,
the root the web UI scans.

## Why the separation

The web UI resumes any session it can see the moment you open it
(\`@deepseek-ai/dsh-api-session-controller\` calls \`ctx.agents.resume\`): the
session becomes a live agent in the web process, which then appends to the same
log with its own seq counter. Two processes writing one session log
concurrently corrupts it (duplicate or missing seq — the UI then reports
"corrupt session log"). Keeping these sessions under their own root makes them
invisible to the web profile, so the web UI can never accidentally resume them.

## Same backend, different root

The logs here use exactly the same JSONL persistence backend and defaults as
\`$DSH_HOME/sessions\` — only the root differs:

\`\`\`
<root>/--<normalized-cwd>--/<session-id>/session.jsonl.zstd
\`\`\`

## Monitoring

There is no web view for these sessions by design. Watch the onebot process
console instead (\`[onebot info] message from …\` / \`send to …\`).
`;

/** 建隐藏会话根目录并种下 README；README 只在缺失时写入。 */
export async function ensureHiddenSessionsDocs(root: string): Promise<void> {
	await mkdir(root, { recursive: true });
	try {
		await writeFile(join(root, "README.md"), SESSIONS_HIDDEN_README, { flag: "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
}
