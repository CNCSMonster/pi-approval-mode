#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

const MIN_COVERAGE = 80.0;

// 获取 extensions/ 目录下的全部核心模块文件名
const extensionsDir = join(rootDir, "extensions");
const coreModuleNames = readdirSync(extensionsDir)
	.filter((f) => f.endsWith(".ts"))
	.sort();

console.log(`[Coverage Gate] Running test suite with coverage enforcement (threshold: ${MIN_COVERAGE}%)...`);

const result = spawnSync(
	process.execPath,
	["--test", "--experimental-test-coverage", "--experimental-strip-types", "tests/*.ts"],
	{
		cwd: rootDir,
		encoding: "utf8",
		env: { ...process.env },
		maxBuffer: 50 * 1024 * 1024,
	},
);

// 无论成功还是失败，都输出 Node test 的控制台详情
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

if (result.status !== 0) {
	console.error(`\n❌ [Coverage Gate FAILED] Test suite failed with exit code ${result.status}`);
	process.exit(result.status ?? 1);
}

// 解析覆盖率表格
const output = result.stdout || "";
const lines = output.split("\n");

const moduleCoverages = new Map();

for (const line of lines) {
	// 匹配表格行，例如：
	// ℹ  approval-config.ts       | 100.00 |   100.00 |  100.00 |
	const match = line.match(/^\s*ℹ\s+([\w-]+\.ts)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
	if (match) {
		const [, fileName, linePct, branchPct, funcPct] = match;
		moduleCoverages.set(fileName, {
			file: fileName,
			line: parseFloat(linePct),
			branch: parseFloat(branchPct),
			funcs: parseFloat(funcPct),
		});
	}
}

const violations = [];

console.log("\n==================== 核心模块覆盖率门禁检查 ====================");

for (const moduleName of coreModuleNames) {
	const cov = moduleCoverages.get(moduleName);
	if (!cov) {
		violations.push(`核心模块 ${moduleName} 未在覆盖率报告中找到数据 (未被引入或无测试)`);
		continue;
	}

	const isLineOk = cov.line >= MIN_COVERAGE;
	const isBranchOk = cov.branch >= MIN_COVERAGE;
	const isFuncOk = cov.funcs >= MIN_COVERAGE;

	const status = isLineOk && isBranchOk && isFuncOk ? "✅ PASS" : "❌ FAIL";
	console.log(
		`${status} | ${moduleName.padEnd(26)} | Line: ${cov.line.toFixed(2)}% | Branch: ${cov.branch.toFixed(2)}% | Func: ${cov.funcs.toFixed(2)}%`,
	);

	if (!isLineOk) {
		violations.push(`模块 ${moduleName} 行覆盖率 (${cov.line}%) 低于门禁阈值 ${MIN_COVERAGE}%`);
	}
	if (!isBranchOk) {
		violations.push(`模块 ${moduleName} 分支覆盖率 (${cov.branch}%) 低于门禁阈值 ${MIN_COVERAGE}%`);
	}
	if (!isFuncOk) {
		violations.push(`模块 ${moduleName} 函数覆盖率 (${cov.funcs}%) 低于门禁阈值 ${MIN_COVERAGE}%`);
	}
}

console.log("================================================================\n");

if (violations.length > 0) {
	console.error("❌ [Coverage Gate FAILED] 存在不满足覆盖率门禁要求的核心模块：");
	for (const v of violations) {
		console.error(`  - ${v}`);
	}
	process.exit(1);
}

console.log(`✅ [Coverage Gate PASSED] 所有 ${coreModuleNames.length} 个核心模块覆盖率（Line / Branch / Func）均达到或超过 ${MIN_COVERAGE}%！\n`);
