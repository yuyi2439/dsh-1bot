// Profile patch seeding: write a commented onebot config template into the
// profile's cordis.patch.yml on first setup, so the user opening the file
// sees exactly what to configure instead of the bare `[]` placeholder that
// `dsh plugin` initializes.
//
// Safety: only touches the file when it is still the empty placeholder
// (`[]` or comments-only) AND does not already carry our template header;
// real user content is never overwritten. The seeded template stays
// commented out with a trailing `[]`, so the bundle defaults keep applying
// until the user uncomments and edits.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OnebotConfig } from "./types.ts";

/** The profile this bundle is documented to be installed into. */
const PROFILE_NAME = "onebot";

/** The profile's user patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`). */
export function profilePatchPath(): string {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "profiles", PROFILE_NAME, "cordis.patch.yml");
}

/** Marker line identifying the seeded template (idempotence check). */
export const PROFILE_TEMPLATE_HEADER = "# dsh-1bot 配置模板";

/**
 * The commented config template, built from the resolved config values and
 * APPENDED to the placeholder file (the file's original comments and `[]`
 * stay untouched, so the patch list remains valid and inert until the user
 * uncomments and deletes the top `[]`). Fully commented — every line starts
 * with `#`.
 */
export function buildPatchTemplate(config: OnebotConfig): string {
	const q = (s: string): string => `'${s}'`;
	const lines = [
		"\n",
		PROFILE_TEMPLATE_HEADER,
		"# 启用方式：取消下面的注释，并把文件顶部的 `[]` 删除。",
		"# id 定向 patch 会整段替换该行 config，修改时保留所有字段。",
		"# - id: onebot",
		"#   config:",
		`#     enabled: ${config.enabled}`,
		`#     mode: ${config.mode}`,
		`#     ws_url: ${q(config.ws_url)}`,
		`#     access_token: ${q(config.access_token)}`,
		`#     prefix: ${q(config.prefix)}`,
		`#     friend_ids: [${config.friend_ids.join(", ")}]    # 私聊白名单；空 = 无人可入`,
		`#     group_ids: [${config.group_ids.join(", ")}]      # 群白名单；空 = 无群可入`,
		`#     reply_chunk_size: ${config.reply_chunk_size}`,
		`#     reply_chunk_delay_ms: ${config.reply_chunk_delay_ms}`,
		`#     max_pending_turns: ${config.max_pending_turns}`,
		`#     console_log: ${config.console_log}`,
	];
	return lines.join("\n") + "\n";
}

/**
 * APPEND the commented template when the patch file has no `- id: onebot`
 * row (the plugin is not configured). The original content is preserved,
 * never replaced. Returns `true` when it seeded (row was missing), `false`
 * when the row exists or the file is missing. Idempotent: after seeding the
 * template's own `# - id: onebot` line satisfies the check, so a later run
 * never seeds twice.
 * @param config - resolved plugin config (template shows the effective values).
 * @param file - patch path (overridable for tests).
 */
export async function seedProfilePatch(config: OnebotConfig, file: string = profilePatchPath()): Promise<boolean> {
	let content: string;
	try {
		content = await readFile(file, "utf8");
	} catch {
		return false; // profile not set up yet — nothing to seed
	}
	if (content.includes("- id: onebot")) return false; // row exists (or already seeded)
	await writeFile(file, content.replace(/\s*$/, "\n") + buildPatchTemplate(config), "utf8");
	return true;
}
