#!/usr/bin/env node
/**
 * 采集数据集工具：删除权与导出权（与采集同批交付的承诺面）
 *
 * 用法（在 pi-approval-mode 仓根执行）：
 *   npm run dataset:delete -- --call-id <uuid> [--call-id <uuid> ...]
 *   npm run dataset:delete -- --before 2026-10-01
 *   npm run dataset:delete -- --all --yes
 *   npm run dataset:export  [--call-id <uuid> ...] [--before <日期>] [--out <文件>]
 *
 * 默认操作目录：~/.pi/agent/approval-captures（可用 --dir 覆盖）。
 * 安全删除纪律：删除范围必须显式（callId / before / all）；全量删除必须追加 --yes。
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CAPTURE_DIR_NAME, deleteCaptureRecords, exportCaptureRecords } from "../extensions/approval-capture.ts";

function usage(): void {
	console.log(
		[
			"采集数据集工具（删除权 / 导出权）",
			"",
			"  delete --call-id <uuid> [...]        按 callId 删除（A/B 成对移除）",
			"  delete --before <ISO 日期|毫秒>      删除该时间点（含）之前的记录",
			"  delete --all --yes                   全量删除（必须显式 --yes）",
			"  export [--call-id ...] [--before ...] [--out <文件>]",
			"                                       导出（空筛选 = 全量；导出前二次脱敏）",
			"",
			"通用参数：--dir <采集目录>（默认 ~/.pi/agent/approval-captures）",
		].join("\n"),
	);
}

interface CliFlags {
	callIds: string[];
	beforeMs?: number;
	all: boolean;
	yes: boolean;
	out?: string;
	dir?: string;
}

function parseFlags(argv: string[]): CliFlags {
	const flags: CliFlags = { callIds: [], all: false, yes: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--call-id" && argv[i + 1]) {
			flags.callIds.push(argv[++i]);
		} else if (arg === "--before" && argv[i + 1]) {
			const raw = argv[++i];
			const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
			if (!Number.isFinite(parsed)) {
				console.error(`无法解析 --before: ${raw}（支持 ISO 日期或毫秒时间戳）`);
				process.exit(2);
			}
			flags.beforeMs = parsed;
		} else if (arg === "--all") {
			flags.all = true;
		} else if (arg === "--yes") {
			flags.yes = true;
		} else if (arg === "--out" && argv[i + 1]) {
			flags.out = argv[++i];
		} else if (arg === "--dir" && argv[i + 1]) {
			flags.dir = argv[++i];
		} else {
			console.error(`未知参数: ${arg}`);
			usage();
			process.exit(2);
		}
	}
	return flags;
}

const command = process.argv[2];
const flags = parseFlags(process.argv.slice(3));
const captureDir = flags.dir ? resolve(flags.dir) : join(homedir(), ".pi", "agent", CAPTURE_DIR_NAME);

if (command === "delete") {
	try {
		const summary = deleteCaptureRecords(captureDir, {
			callIds: flags.callIds,
			beforeMs: flags.beforeMs,
			all: flags.all,
			confirmAll: flags.yes,
		});
		console.log("【删除完成】");
		console.log(`  扫描文件: ${summary.filesScanned} | 扫描记录: ${summary.recordsScanned}`);
		console.log(`  删除记录: ${summary.recordsRemoved} | 清空文件: ${summary.filesEmptied} | 清扫策略: ${summary.policiesSwept}`);
		console.log(`  操作目录: ${captureDir}`);
	} catch (err) {
		console.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
} else if (command === "export") {
	const stamp = new Date().toISOString().slice(0, 10);
	const outPath = flags.out ? resolve(flags.out) : resolve(`./approval-captures-export-${stamp}.jsonl`);
	try {
		const summary = exportCaptureRecords(captureDir, { callIds: flags.callIds, beforeMs: flags.beforeMs }, outPath);
		console.log("【导出完成】");
		console.log(`  导出记录: ${summary.recordsExported} | 覆盖调用: ${summary.callsExported}`);
		console.log(`  输出文件: ${summary.outputPath}`);
		console.log("  说明：导出前已执行二次脱敏；文件仍含业务上下文，请妥善保管。");
	} catch (err) {
		console.error(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
} else {
	usage();
	process.exit(2);
}
