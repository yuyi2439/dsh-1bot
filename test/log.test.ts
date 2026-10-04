// log 模块（src/log.ts）的测试：纯文本行渲染与控制台 exporter 的注册。
//
// `levels: { onebot: 2, default: -1 }` 的断言锁住硬性规则 7：丢掉 `default: -1`
// 会让其他插件每条 info 日志都泄漏到控制台。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Exporter, LoggerService, Message } from "@deepseek-ai/cordis";
import { formatLogLine, mountConsoleExporter } from "../src/log.ts";

/** 一条结构化记录，带 `formatLogLine` 会读取的字段。 */
function makeMessage(overrides: Partial<Message> = {}): Message {
	return { sn: 1, ts: Date.UTC(2026, 0, 2, 3, 4, 5), name: "onebot", type: "info", level: 1, args: [], ...overrides };
}

/** 某个时刻在**本机时区**下的渲染结果（`new Date().toString()` 的格式）。 */
function localStamp(ms: number): string {
	return new Date(ms).toString();
}

/** 渲染一条记录，用**生产同一份** exporter 选项（含安全 formatters）。 */
function render(overrides: Partial<Message> = {}, localTime = true): string {
	return formatLogLine(captureExporter(localTime), makeMessage(overrides), localTime);
}

/** 通过假 logger 服务捕获 exporter（`localTime` 即生产里传给 exporter 的那个开关）。 */
function captureExporter(localTime = true): Exporter {
	let captured: Exporter | undefined;
	const logger = {
		exporter: (exporter: Exporter) => {
			captured = exporter;
			return (async () => {}) as never;
		},
	} as unknown as LoggerService;
	mountConsoleExporter(logger, localTime);
	assert.ok(captured, "mountConsoleExporter must register exactly one exporter");
	return captured;
}

/** 在 `body` 执行期间捕获 stdout/stderr 的写入，而不是真的打印出去。 */
async function captureWrites(body: () => void): Promise<{ out: string; err: string }> {
	const stdout = process.stdout.write;
	const stderr = process.stderr.write;
	let out = "";
	let err = "";
	process.stdout.write = ((chunk: unknown) => {
		out += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		err += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		body();
	} finally {
		process.stdout.write = stdout;
		process.stderr.write = stderr;
	}
	return { out, err };
}

test("formatLogLine renders a tagged, timestamped single line", () => {
	const line = render({ args: ["hello", "world"] });
	const stamp = localStamp(Date.UTC(2026, 0, 2, 3, 4, 5));
	assert.equal(line, `[onebot info] ${stamp} hello world`);
});

test("formatLogLine prints local time with an explicit offset, never bare UTC", () => {
	const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
	const line = render({});
	// 本机时区就是断言里的时区：终端前的人按本地时间读日志。
	assert.ok(line.startsWith(`[onebot info] ${localStamp(ms)}`), `unexpected line: ${line}`);
	// `toString()` 的写法自带 UTC 偏移与本地化时区名，读者不会误当 UTC。
	assert.match(line, /^\[onebot info\] \w{3} \w{3} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}/, `unexpected line: ${line}`);
});

test("formatLogLine labels the severity from the message itself", () => {
	assert.ok(render({ type: "warn" }).startsWith("[onebot warn]"));
	// 标签来自 `message.name` —— 绝不硬编码。
	assert.ok(render({ name: "other" }).startsWith("[other info]"));
});

test("formatLogLine delegates printf placeholders to cordis", () => {
	// 正文交给 cordis 的格式化器：`%s` / `%d` 必须被替换，不能原样打出来。
	const line = render({ args: ["connected to %s in %d ms", "ws://h:3001", 12] });
	assert.ok(line.endsWith("connected to ws://h:3001 in 12 ms"), `unexpected line: ${line}`);
});

test("formatLogLine consumes `%c` style args instead of leaking them", () => {
	// cordis 的日志习惯用 `%c` 着色；样式参数必须被吃掉，不能出现在日志里。
	const line = render({ args: ["%c onebot %c connected", "color:red", "color:green"] });
	assert.ok(!line.includes("%c"), `placeholder leaked: ${line}`);
	assert.ok(!line.includes("color:red"), `style arg leaked: ${line}`);
	assert.ok(line.includes("connected"), `unexpected line: ${line}`);
});

test("formatLogLine expands an Error into its stack", () => {
	// 直接把 Error 当参数传是 cordis 的常见用法；不能渲染成 `{}`。
	const line = render({ args: [new Error("boom")] });
	assert.ok(line.includes("Error: boom"), `unexpected line: ${line}`);
	assert.ok(line.includes("at "), `stack missing: ${line}`);
});

test("formatLogLine renders non-string args readably", () => {
	const line = render({ args: [{ a: 1 }, 42, true] });
	assert.ok(line.endsWith('{"a":1} 42 true'), `unexpected line: ${line}`);
});

test("formatLogLine survives an arg that cannot be serialized", () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	// 环形对象：cordis 默认的 `o` formatter 会抛 TypeError，渲染抛错会连带把调用方
	// 打日志的那段逻辑炸掉。这一行必须仍然产出。
	const line = render({ args: [cyclic] });
	assert.ok(line.startsWith(`[onebot info] ${localStamp(Date.UTC(2026, 0, 2, 3, 4, 5))}`), `unexpected line: ${line}`);
});

test("formatLogLine truncates at the exporter's maxLength", () => {
	// cordis 的格式化器按 exporter 的 maxLength 截断，避免超长行刷屏。
	const long = "x".repeat(50);
	const exporter: Exporter = { ...captureExporter(), maxLength: 10 };
	const line = formatLogLine(exporter, makeMessage({ args: [long] }));
	assert.ok(line.endsWith("xxxxxxxxxx..."), `unexpected line: ${line}`);
});

test("the exporter pins `default: -1` so other plugins never leak", () => {
	const exporter = captureExporter();
	assert.deepEqual(exporter.levels, { onebot: 2, default: -1 });
	assert.equal(exporter.colors, 0);
});

test("the exporter writes errors to stderr and everything else to stdout", async () => {
	const exporter = captureExporter();
	const stamp = localStamp(Date.UTC(2026, 0, 2, 3, 4, 5));
	const { out, err } = await captureWrites(() => {
		exporter.export(makeMessage({ type: "info", args: ["info line"] }));
		exporter.export(makeMessage({ type: "warn", args: ["warn line"] }));
		exporter.export(makeMessage({ type: "error", args: ["error line"] }));
	});
	assert.equal(err, `[onebot error] ${stamp} error line\n`);
	assert.equal(
		out,
		`[onebot info] ${stamp} info line\n[onebot warn] ${stamp} warn line\n`,
	);
});

test("each exported record ends with exactly one newline", async () => {
	const exporter = captureExporter();
	const { out } = await captureWrites(() => {
		exporter.export(makeMessage({ args: ["no trailing newline"] }));
	});
	assert.equal(out.split("\n").length, 2, "one line plus the terminating empty split");
});
