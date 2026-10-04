// 首次 setup 时向 profile 的 cordis.patch.yml 追加注释形式的配置模板，让用户
// 打开文件就能看到该配什么。只在文件还没有 `- id: onebot` 行时追加；已有内容
// 一律保留。模板整体保持注释，因此用户取消注释之前 bundle 默认值继续生效。
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OnebotConfig } from "./config.ts";

/** 该 bundle 所属的 profile 名。 */
const PROFILE_NAME = "onebot";

/** profile 的用户 patch 层路径。 */
export function profilePatchPath(): string {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "profiles", PROFILE_NAME, "cordis.patch.yml");
}

/** 标识已写入种子模板的标记行（幂等检查用）。 */
export const PROFILE_TEMPLATE_HEADER = "# dsh-1bot 配置模板";

/** 把一条 adapter 记录渲染成模板里的 `adapters` 列表项（保持注释状态）。 */
function adapterLines(type: string, config: Record<string, unknown>, indent: string): string[] {
	const lines = [`${indent}- type: ${type}`];
	const fields = Object.entries(config);
	if (fields.length > 0) {
		lines.push(`${indent}  config:`);
		for (const [key, value] of fields) {
			// 数组写 YAML 数组，字符串加引号，其余标量直接写。
			let rendered: string;
			if (Array.isArray(value)) rendered = `[${value.join(", ")}]`;
			else if (typeof value === "string") rendered = `'${value}'`;
			else rendered = String(value);
			lines.push(`${indent}    ${key}: ${rendered}`);
		}
	}
	return lines;
}

/**
 * 注释形式的配置模板，由解析后的配置值构建。adapter 段按实际启用的 adapter
 * 逐条渲染；具体有哪些类型见 adapter/ 的实现表。
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
		`#     access_token: ${q(config.access_token)}`,
		`#     prefix: ${q(config.prefix)}`,
		"#     adapters:            # 接入哪些 adapter；连接地址与白名单都在各自 config 里",
	];
	for (const entry of config.adapters) {
		lines.push(...adapterLines(entry.type, entry.config, "#       "));
	}
	lines.push(
		`#     reply_chunk_size: ${config.reply_chunk_size}`,
		`#     reply_chunk_delay_ms: ${config.reply_chunk_delay_ms}`,
		`#     console_log: ${config.console_log}`,
		`#     log_local_time: ${config.log_local_time}`,
	);
	return lines.join("\n") + "\n";
}

/**
 * patch 文件里没有 `- id: onebot` 行时把注释模板追加进去；已有内容一律保留。
 * @param config - 解析后的插件配置（模板展示生效值）。
 * @param file - patch 路径（测试可覆盖）。
 * @returns 本次是否种下了模板；文件不存在或该行已存在时为 false。
 */
export async function seedProfilePatch(config: OnebotConfig, file: string = profilePatchPath()): Promise<boolean> {
	let content: string;
	try {
		content = await readFile(file, "utf8");
	} catch {
		return false; // profile 还没建好
	}
	if (content.includes("- id: onebot")) return false;
	await writeFile(file, content.replace(/\s*$/, "\n") + buildPatchTemplate(config), "utf8");
	return true;
}
