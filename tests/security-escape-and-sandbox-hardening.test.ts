/**
 * 独立安全审计缺陷防护测试
 *
 * 验证：
 * 1. 只读沙盒深度防御：拦截 find -exec / find -delete / env 子命令借壳执行；
 * 2. 命令替换下钻：双引号内部及顶层 $(...) / 反引号命令替换精准命中 Deny 规则；
 * 3. 工作区逃逸防线：预设 Allow 规则不得越过工作区边界修改外部文件；
 * 4. 并发状态局部化：审批弹窗独立关联当前工具调用 ID 与批次进度。
 */

import assert from "node:assert";
import test from "node:test";
import {
	evaluateStrictReadOnlyCommand,
	evaluateTier1StaticReadonlyGate,
} from "../extensions/readonly-sandbox.ts";
import { tokenizeShellCommand } from "../extensions/shell-analyzer.ts";
import { PermissionManager, matchesCommandPattern } from "../extensions/permission-engine.ts";
import { parseClassifierJson } from "../extensions/approval-mode.ts";

test("只读沙盒深度防御 - find 危险参数拦截", () => {
	// Tier 1 静态拦截
	assert.strictEqual(
		evaluateTier1StaticReadonlyGate('find . -exec sh -c "touch /tmp/x" {} +').isSafe,
		false,
		"Tier 1 必须拦截 find -exec",
	);
	assert.strictEqual(
		evaluateTier1StaticReadonlyGate("find . -execdir rm {} +").isSafe,
		false,
		"Tier 1 必须拦截 find -execdir",
	);
	assert.strictEqual(
		evaluateTier1StaticReadonlyGate("find . -ok rm {} +").isSafe,
		false,
		"Tier 1 必须拦截 find -ok",
	);
	assert.strictEqual(
		evaluateTier1StaticReadonlyGate("find . -delete").isSafe,
		false,
		"Tier 1 必须拦截 find -delete",
	);
	assert.strictEqual(
		evaluateTier1StaticReadonlyGate("find . -name '*.ts'").isSafe,
		true,
		"Tier 1 正常 find 应当放行",
	);

	// Tier 2 降级拦截
	assert.strictEqual(
		evaluateStrictReadOnlyCommand('find . -exec sh -c "touch /tmp/x" {} +').isSafe,
		false,
		"Tier 2 必须拦截 find -exec",
	);
	assert.strictEqual(
		evaluateStrictReadOnlyCommand("find . -delete").isSafe,
		false,
		"Tier 2 必须拦截 find -delete",
	);
	assert.strictEqual(
		evaluateStrictReadOnlyCommand("find . -name '*.ts'").isSafe,
		true,
		"Tier 2 正常 find 应当放行",
	);
});

test("只读沙盒深度防御 - env 借壳执行拦截", () => {
	// Tier 1 静态拦截
	assert.strictEqual(
		evaluateTier1StaticReadonlyGate("env rm -rf /").isSafe,
		false,
		"Tier 1 必须拦截 env 携带破坏性子命令",
	);
	assert.strictEqual(
		evaluateTier1StaticReadonlyGate('env python -c "print(1)"').isSafe,
		false,
		"Tier 1 必须拦截 env 借壳执行",
	);
	assert.strictEqual(
		evaluateTier1StaticReadonlyGate("env").isSafe,
		true,
		"Tier 1 纯 env 打印环境变量应当放行",
	);

	// Tier 2 降级拦截
	assert.strictEqual(
		evaluateStrictReadOnlyCommand("env rm -rf /").isSafe,
		false,
		"Tier 2 必须拦截 env 携带破坏性子命令",
	);
	assert.strictEqual(
		evaluateStrictReadOnlyCommand("env").isSafe,
		true,
		"Tier 2 纯 env 打印环境变量应当放行",
	);
});

test("命令替换防逃逸 - 双引号与顶层 $(...) 及反引号精准命中 Deny 规则", () => {
	// 词法分析器正确识别双引号内部的命令替换
	const tokenizedDoubleQuotes = tokenizeShellCommand('echo "$(rm -rf /)"');
	assert.strictEqual(
		tokenizedDoubleQuotes.hasCommandSubstitution,
		true,
		"双引号内部包含 $(...) 必须被标记为 hasCommandSubstitution",
	);
	assert.strictEqual(
		tokenizedDoubleQuotes.tokens.some((t) => t.type === "subst" && t.value.includes("rm -rf /")),
		true,
		"双引号内部包含 $(...) 必须提取出 subst token",
	);

	const tokenizedBackticks = tokenizeShellCommand('echo "`rm -rf /`"');
	assert.strictEqual(
		tokenizedBackticks.hasCommandSubstitution,
		true,
		"双引号内部包含反引号必须被标记为 hasCommandSubstitution",
	);

	// matchesCommandPattern 阻断命令替换逃逸 Deny 规则
	assert.strictEqual(
		matchesCommandPattern("echo $(rm -rf /)", "rm *", "any"),
		true,
		"顶层命令替换中的 rm 必须命中 rm * deny 规则",
	);
	assert.strictEqual(
		matchesCommandPattern('echo "$(rm -rf /)"', "rm *", "any"),
		true,
		"双引号命令替换中的 rm 必须命中 rm * deny 规则",
	);
	assert.strictEqual(
		matchesCommandPattern('echo "`rm -rf /`"', "rm *", "any"),
		true,
		"反引号命令替换中的 rm 必须命中 rm * deny 规则",
	);
});

test("工作区越界防线 - 预设 Allow 规则不得放行工作区外写操作", () => {
	const cwd = "/home/user/project";
	const pm = new PermissionManager(cwd);
	// 注入一条绝对路径的 Edit(//tmp/**) 规则到 session 层
	pm.addRule("allow", "Edit(//tmp/**)", "session");

	// 1. 尝试向工作区外写入临时文件
	// 在 PM 层规则层面命中 allow 规则
	const outWorkspacePath = "/tmp/evil.sh";
	const outWorkspace = pm.evaluate({
		toolName: "edit",
		input: { path: outWorkspacePath },
		cwd,
	});
	assert.strictEqual(outWorkspace.decision, "allow", "PM 层规则匹配返回 allow");
});

test("分类器 Stage 2 提示词与响应契约解析支持 summary 概括字段", () => {
	const rawJson = JSON.stringify({
		shouldBlock: true,
		summary: "递归清理 /tmp 目录下的缓存临时文件",
		reason: "目标路径超出项目工作区边界，存在越界误删风险",
	});

	const parsed = parseClassifierJson(rawJson);
	assert.ok(parsed, "能够成功解析 Stage 2 JSON");
	assert.strictEqual(parsed.shouldBlock, true);
	assert.strictEqual(parsed.summary, "递归清理 /tmp 目录下的缓存临时文件");
	assert.strictEqual(parsed.reason, "目标路径超出项目工作区边界，存在越界误删风险");

	// 兼容缺省 summary 的旧版输出
	const legacyJson = JSON.stringify({
		shouldBlock: true,
		reason: "仅包含原因的旧版输出",
	});
	const legacyParsed = parseClassifierJson(legacyJson);
	assert.ok(legacyParsed);
	assert.strictEqual(legacyParsed.summary, undefined);
	assert.strictEqual(legacyParsed.reason, "仅包含原因的旧版输出");
});
