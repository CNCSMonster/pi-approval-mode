/**
 * extensions/logger.ts
 *
 * 分类器非侵入式文件日志记录器
 *
 * 宿主 pi-tui 主屏基于相对光标位移 diff 渲染。若插件直接通过 console.* 输出到
 * stdout/stderr，会导致终端物理光标与渲染器坐标脱节，引发输入框被覆盖和 TUI 假死。
 *
 * 本模块提供安全的文件日志追加记录，默认写入 ~/.pi/agent/logs/approval-mode.log，
 * 彻底消除分类器热路径对终端输出流的直写污染。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 内存保留最近日志行（方便测试断言与瞬态排查）
const RECENT_LOGS_LIMIT = 100;
const recentLogs: string[] = [];

/**
 * 获取日志文件目标路径
 */
export function getLogFilePath(): string {
	if (process.env.PI_APPROVAL_MODE_LOG_PATH) {
		return process.env.PI_APPROVAL_MODE_LOG_PATH;
	}
	try {
		return path.join(os.homedir(), ".pi", "agent", "logs", "approval-mode.log");
	} catch {
		return path.join(process.cwd(), "approval-mode.log");
	}
}

/**
 * 格式化异常对象
 */
function formatErrorDetail(err: unknown): string {
	if (!err) return "";
	if (err instanceof Error) {
		return err.stack ? `\n${err.stack}` : `\n${err.name}: ${err.message}`;
	}
	if (typeof err === "object") {
		try {
			return `\n${JSON.stringify(err, null, 2)}`;
		} catch {
			return `\n${String(err)}`;
		}
	}
	return `\n${String(err)}`;
}

/**
 * 追加写入日志行
 */
function appendToLogFile(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string, err?: unknown): void {
	const timestamp = new Date().toISOString();
	const errStr = formatErrorDetail(err);
	const entry = `[${timestamp}] [${level}] ${message}${errStr}`;

	// 记录到内存环形缓冲区
	recentLogs.push(entry);
	if (recentLogs.length > RECENT_LOGS_LIMIT) {
		recentLogs.shift();
	}

	// 仅在明确开启控制台调试环境变量时才输出控制台（默认严禁输出，防止破坏 TUI）
	if (process.env.PI_APPROVAL_MODE_DEBUG === "1") {
		if (level === "ERROR") {
			console.error(entry);
		} else if (level === "WARN") {
			console.warn(entry);
		} else {
			console.log(entry);
		}
	}

	// 写入本地持久化文件
	try {
		const filePath = getLogFilePath();
		const dirPath = path.dirname(filePath);
		if (!fs.existsSync(dirPath)) {
			fs.mkdirSync(dirPath, { recursive: true });
		}
		fs.appendFileSync(filePath, `${entry}\n`, "utf8");
	} catch {
		// 严禁因文件 I/O 错误影响主流程，静默捕获
	}
}

/**
 * 记录分类器警告日志
 */
export function logClassifierWarn(message: string): void {
	appendToLogFile("WARN", message);
}

/**
 * 记录分类器错误日志
 */
export function logClassifierError(message: string, err?: unknown): void {
	appendToLogFile("ERROR", message, err);
}

/**
 * 记录分类器信息日志
 */
export function logClassifierInfo(message: string): void {
	appendToLogFile("INFO", message);
}

/**
 * 记录分类器调试日志
 */
export function logClassifierDebug(message: string): void {
	appendToLogFile("DEBUG", message);
}

/**
 * 获取最近写入的内存日志列表（供单元测试使用）
 */
export function getRecentLogs(): readonly string[] {
	return recentLogs;
}

/**
 * 清空内存日志缓冲区（供单元测试使用）
 */
export function clearRecentLogs(): void {
	recentLogs.length = 0;
}
