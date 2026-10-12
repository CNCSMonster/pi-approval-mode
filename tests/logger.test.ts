/**
 * tests/logger.test.ts
 *
 * 分类器安全文件日志记录器单元测试
 */

import { test } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	logClassifierInfo,
	logClassifierWarn,
	logClassifierError,
	logClassifierDebug,
	getRecentLogs,
	clearRecentLogs,
	getLogFilePath,
} from "../extensions/logger.ts";

test("logger - 基本日志级别记录与格式规范", () => {
	clearRecentLogs();

	logClassifierInfo("Stage 1 test info");
	logClassifierWarn("Stage 1 test warning");
	logClassifierError("Stage 2 test error");
	logClassifierDebug("Debug message");

	const logs = getRecentLogs();
	assert.strictEqual(logs.length, 4);
	assert.match(logs[0], /\[INFO\] Stage 1 test info/);
	assert.match(logs[1], /\[WARN\] Stage 1 test warning/);
	assert.match(logs[2], /\[ERROR\] Stage 2 test error/);
	assert.match(logs[3], /\[DEBUG\] Debug message/);
});

test("logger - 异常对象格式化 (Error 堆栈 / 对象 JSON / 基本类型)", () => {
	clearRecentLogs();

	// 1. Error 实例带 stack
	const testErr = new Error("Custom upstream timeout");
	logClassifierError("Failed calling stage 1", testErr);

	// 2. 普通对象
	const objErr = { status: 402, message: "Insufficient Balance" };
	logClassifierError("Failed with object error", objErr);

	// 3. 基本类型
	logClassifierError("Failed with string", "raw string error");

	const logs = getRecentLogs();
	assert.strictEqual(logs.length, 3);
	assert.match(logs[0], /Custom upstream timeout/);
	assert.match(logs[0], /Error:/);
	assert.match(logs[1], /"status": 402/);
	assert.match(logs[1], /"message": "Insufficient Balance"/);
	assert.match(logs[2], /raw string error/);
});

test("logger - 环境变量覆写日志路径与持久化文件写入", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-logger-test-"));
	const targetLogFile = path.join(tempDir, "custom-sub", "approval.log");
	const originalEnv = process.env.PI_APPROVAL_MODE_LOG_PATH;

	try {
		process.env.PI_APPROVAL_MODE_LOG_PATH = targetLogFile;
		assert.strictEqual(getLogFilePath(), targetLogFile);

		clearRecentLogs();
		logClassifierWarn("Testing file persistence in custom path");

		assert.ok(fs.existsSync(targetLogFile), "日志文件必须被创建");
		const content = fs.readFileSync(targetLogFile, "utf8");
		assert.match(content, /Testing file persistence in custom path/);
	} finally {
		if (originalEnv !== undefined) {
			process.env.PI_APPROVAL_MODE_LOG_PATH = originalEnv;
		} else {
			delete process.env.PI_APPROVAL_MODE_LOG_PATH;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("logger - 环形缓冲区上限限制 (超过 100 条滚动移出)", () => {
	clearRecentLogs();

	for (let i = 0; i < 110; i++) {
		logClassifierInfo(`Log entry number ${i}`);
	}

	const logs = getRecentLogs();
	assert.strictEqual(logs.length, 100);
	assert.match(logs[0], /Log entry number 10/);
	assert.match(logs[99], /Log entry number 109/);
});

test("logger - PI_APPROVAL_MODE_DEBUG 环境变量开启时的控制台联动", () => {
	const originalDebug = process.env.PI_APPROVAL_MODE_DEBUG;
	const originalLog = console.log;
	const originalWarn = console.warn;
	const originalError = console.error;

	const logs: string[] = [];
	const warns: string[] = [];
	const errors: string[] = [];

	console.log = (...args: any[]) => logs.push(args.join(" "));
	console.warn = (...args: any[]) => warns.push(args.join(" "));
	console.error = (...args: any[]) => errors.push(args.join(" "));

	try {
		process.env.PI_APPROVAL_MODE_DEBUG = "1";

		logClassifierInfo("Debug info");
		logClassifierWarn("Debug warn");
		logClassifierError("Debug error");

		assert.strictEqual(logs.length, 1);
		assert.match(logs[0], /\[INFO\] Debug info/);
		assert.strictEqual(warns.length, 1);
		assert.match(warns[0], /\[WARN\] Debug warn/);
		assert.strictEqual(errors.length, 1);
		assert.match(errors[0], /\[ERROR\] Debug error/);
	} finally {
		console.log = originalLog;
		console.warn = originalWarn;
		console.error = originalError;
		if (originalDebug !== undefined) {
			process.env.PI_APPROVAL_MODE_DEBUG = originalDebug;
		} else {
			delete process.env.PI_APPROVAL_MODE_DEBUG;
		}
	}
});
