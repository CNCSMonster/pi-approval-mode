import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager, isDangerousAllowRule } from "../extensions/permission-engine.ts";

// ==============================================================
// A. 危险 allow 判据（对齐 qwen-code dangerousRules.ts）
// ==============================================================

test("危险 allow 判据 - 危险表：裸规则/通配/解释器组合命中", () => {
	const dangerous = [
		"Bash", // 裸工具级 = 全放行
		"Bash(*)",
		"bash(*)",
		"Bash(python *)", // 解释器 × 通配
		"Bash(python)", // 解释器裸名
		"Bash(npx *)", // 包运行器（经典绕过面）
		"Bash(node -e *)",
		"Bash(/usr/bin/python3 *)", // 绝对路径形式
		"Bash(bun run *)",
		"Bash(ssh *)",
		"Bash(eval *)",
		"monitor", // shell 族等价工具
	];
	for (const r of dangerous) {
		assert.equal(isDangerousAllowRule(r), true, `应判危险: ${r}`);
	}
});

test("危险 allow 判据 - 安全表：具体命令与非 shell 工具不剥离", () => {
	const safe = [
		"Bash(git status)", // 用户明确信任的具体命令
		"Bash(git push *)", // 非解释器通配（qwen 语义：rm/git 通配不属解释器类）
		"Bash(npm test)", // 多词具体命令（解释器 + 具体子命令）
		"Bash(python script.py)", // 解释器 + 具体脚本
		"Bash(rm -rf *)",
		"Read(*)", // 非 shell 族，判据不适用
		"Edit(*)",
		"Read(.env*)",
		"Edit(./config/**)",
	];
	for (const r of safe) {
		assert.equal(isDangerousAllowRule(r), false, `应判安全: ${r}`);
	}
});

// ==============================================================
// B. 进入 auto 剥离 / 退出恢复（运行时态，幂等）
// ==============================================================

test("auto 护栏 - strip 剥离危险 allow、具体命令保留、restore 原样归位", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-strip-"));
	try {
		const pm = new PermissionManager(tmpDir, tmpDir);
		pm.addRule("allow", "Bash(npx *)", "session");
		pm.addRule("allow", "Bash(git status)", "session");
		assert.equal(pm.getStashedAllowRules().length, 0);

		const stripped = pm.stripDangerousAllowRulesForAuto();
		assert.deepEqual(stripped, ["Bash(npx *)"]);

		// 剥离后：npx 不再命中 allow（回落 default 兜底 → 模式漏斗）
		const denied = pm.evaluate({ cwd: tmpDir, toolName: "bash", input: { command: "npx foo" } });
		assert.equal(denied.decision, "default");
		// 具体命令仍 allow
		const allowed = pm.evaluate({ cwd: tmpDir, toolName: "bash", input: { command: "git status" } });
		assert.equal(allowed.decision, "allow");

		// 幂等：重复进入不再剥离
		assert.deepEqual(pm.stripDangerousAllowRulesForAuto(), []);

		// 恢复
		pm.restoreDangerousAllowRules();
		const restored = pm.evaluate({ cwd: tmpDir, toolName: "bash", input: { command: "npx foo" } });
		assert.equal(restored.decision, "allow");
		assert.equal(pm.getStashedAllowRules().length, 0);
		// 恢复幂等
		pm.restoreDangerousAllowRules();
		assert.equal(pm.getStashedAllowRules().length, 0);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ==============================================================
// C. 暂存态新增危险 allow：入暂存不激活，退出恢复（qwen AUTO 不变量）
// ==============================================================

test("auto 护栏 - 暂存态下新增危险 allow 进暂存池，退出 auto 后生效", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-strip-add-"));
	try {
		const pm = new PermissionManager(tmpDir, tmpDir);
		pm.stripDangerousAllowRulesForAuto();

		const res = pm.addRule("allow", "Bash(python *)", "session");
		assert.equal(res.stashed, true);

		// 不激活
		const during = pm.evaluate({ cwd: tmpDir, toolName: "bash", input: { command: "python evil.py" } });
		assert.equal(during.decision, "default");
		assert.equal(pm.getStashedAllowRules().length, 1);

		// 恢复后生效
		pm.restoreDangerousAllowRules();
		const after = pm.evaluate({ cwd: tmpDir, toolName: "bash", input: { command: "python evil.py" } });
		assert.equal(after.decision, "allow");

		// 非危险 allow 在暂存态照常激活
		pm.stripDangerousAllowRulesForAuto();
		const ok = pm.addRule("allow", "Bash(git log *)", "session");
		assert.equal(ok.stashed, undefined);
		const live = pm.evaluate({ cwd: tmpDir, toolName: "bash", input: { command: "git log -1" } });
		assert.equal(live.decision, "allow");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ==============================================================
// D. 持久层合成：暂存规则写盘保留，后续写盘不冲掉，恢复后内存归位
// ==============================================================

test("auto 护栏 - 暂存态下项目级写盘保留暂存规则（persistRules 合成）", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-strip-persist-"));
	try {
		const pm = new PermissionManager(tmpDir, tmpDir);
		pm.stripDangerousAllowRulesForAuto();

		const res = pm.addRule("allow", "Bash(npx *)", "project");
		assert.equal(res.stashed, true);

		const filePath = join(tmpDir, ".pi", "approval-rules.json");
		const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
		assert.ok(onDisk.allow.includes("Bash(npx *)"), "磁盘应保留暂存规则");
		assert.equal(pm.getProjectRules().allow.includes("Bash(npx *)"), false, "内存不应激活暂存规则");

		// 后续同层写盘不得冲掉暂存规则
		pm.addRule("deny", "Bash(curl *)", "project");
		const onDisk2 = JSON.parse(readFileSync(filePath, "utf-8"));
		assert.ok(onDisk2.allow.includes("Bash(npx *)"), "后续写盘不应冲掉暂存规则");
		assert.ok(onDisk2.deny.includes("Bash(curl *)"));

		// 退出 auto：内存归位，与磁盘一致
		pm.restoreDangerousAllowRules();
		assert.ok(pm.getProjectRules().allow.includes("Bash(npx *)"));
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ==============================================================
// E. 清空规则时同步清除对应层暂存（防止恢复已清空规则）
// ==============================================================

test("auto 护栏 - clearSessionRules 同时丢弃会话层暂存，恢复不复活已清规则", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-strip-clear-"));
	try {
		const pm = new PermissionManager(tmpDir, tmpDir);
		pm.addRule("allow", "Bash(python *)", "session");
		pm.stripDangerousAllowRulesForAuto();
		assert.equal(pm.getStashedAllowRules().length, 1);

		pm.clearSessionRules();
		assert.equal(pm.getStashedAllowRules().length, 0, "清空会话层应同时清暂存");

		pm.restoreDangerousAllowRules();
		const ev = pm.evaluate({ cwd: tmpDir, toolName: "bash", input: { command: "python a.py" } });
		assert.equal(ev.decision, "default", "已清空的规则不应被恢复复活");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
