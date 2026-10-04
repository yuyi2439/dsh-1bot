// 控制台 exporter（dsh-base 自己不挂，没有它 profile 就是静默的）与日志行渲染。
// 本文件是全插件唯一常规写 stdout/stderr 的地方。
import { Logger, type Exporter, type LoggerService, type Message } from "@deepseek-ai/cordis";

/**
 * 渲染一条日志为单行：`[<name> <type>] <时间> <正文>`。正文交给
 * {@link Logger.format}（占位符、Error 堆栈、maxLength 截断都由它负责）。
 *
 * 时间默认本机时区、带 UTC 偏移（`new Date().toString()` 的格式）；
 * `localTime` 为假时用 `toISOString()`（`Z` 结尾）。
 */
export function formatLogLine(exporter: Exporter, message: Message, localTime = true): string {
	const at = new Date(message.ts);
	const time = localTime ? at.toString() : at.toISOString();
	return `[${message.name} ${message.type}] ${time} ${Logger.format(exporter, message)}`;
}

/**
 * 给 `onebot` logger 注册控制台 exporter。`levels` 里的 `default: -1` 是承重的：
 * 丢了它其他插件的 info 日志会泄漏到控制台。error 走 stderr，其余走 stdout。
 */
export function mountConsoleExporter(logger: LoggerService, localTime = true): void {
	const exporter: Exporter = {
		colors: 0,
		levels: { onebot: 2, default: -1 },
		formatters: {
			// 对象走 JSON；环形/不可序列化时退化为 String，渲染绝不抛错。
			o: (value) => {
				try {
					return JSON.stringify(value) ?? String(value);
				} catch {
					return String(value);
				}
			},
			O: (value) => {
				try {
					return JSON.stringify(value) ?? String(value);
				} catch {
					return String(value);
				}
			},
		},
		export: (message: Message) => {
			const line = formatLogLine(exporter, message, localTime);
			(message.type === "error" ? process.stderr : process.stdout).write(line + "\n");
		},
	};
	logger.exporter(exporter);
}
