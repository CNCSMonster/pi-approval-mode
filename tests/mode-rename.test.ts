import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMode, loadApprovalConfig } from "../extensions/approval-config.ts";

// ==============================================================
// A. 模式改名别名（v0.3.0: default → manual）
//    统一入口覆盖三处摄取点：配置 defaultMode、CLI --approval-mode、历史会话状态
// ==============================================================

test("模式改名 - 别名兼容：旧值 default 映射为 manual，非法值回 undefined", () => {
	assert.equal(normalizeMode("default"), "manual");
	assert.equal(normalizeMode("manual"), "manual");
	for (const m of ["auto-edit", "auto", "yolo", "plan"]) {
		assert.equal(normalizeMode(m), m);
	}
	assert.equal(normalizeMode("bogus"), undefined);
	assert.equal(normalizeMode(undefined), undefined);
	assert.equal(normalizeMode(42), undefined);
	assert.equal(normalizeMode(null), undefined);
});

// ==============================================================
// B. 信任闸 defaultMode 提权剧本（护栏回归）
//    攻击：仓库自带 .pi/approval-config.json 写 defaultMode: "yolo"
//    预期：未信任 → 整份阻断（文件粒度），攻击值不进入配置
// ==============================================================

test("信任闸 - 未信任项目携带 defaultMode yolo 被整体阻断（提权剧本回归）", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-trust-cfg-"));
	try {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "approval-config.json"),
			JSON.stringify({ defaultMode: "yolo" }, null, 2),
		);
		// 隔离的 agent 目录（无全局配置），断言不依赖真实环境
		const agentDir = join(tmpDir, "agent-home");

		// 信任：项目配置生效
		const trusted = loadApprovalConfig(tmpDir, true, agentDir);
		assert.equal(trusted.projectConfigFound, true);
		assert.equal(trusted.projectConfigBlocked, false);
		assert.equal(trusted.config.defaultMode, "yolo");

		// 未信任：整份阻断，攻击值完全不进入配置
		const untrusted = loadApprovalConfig(tmpDir, false, agentDir);
		assert.equal(untrusted.projectConfigFound, true);
		assert.equal(untrusted.projectConfigBlocked, true);
		assert.equal(untrusted.config.defaultMode, undefined);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("模式改名 - 配置入口经别名归一：旧配置 defaultMode \"default\" 归一为 manual", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-alias-cfg-"));
	try {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "approval-config.json"),
			JSON.stringify({ defaultMode: "default" }, null, 2),
		);
		const agentDir = join(tmpDir, "agent-home");
		const { config } = loadApprovalConfig(tmpDir, true, agentDir);
		// 文件层保留原值；启动链经 normalizeMode 归一（下方断言入口契约）
		assert.equal(config.defaultMode, "default" as any);
		assert.equal(normalizeMode(config.defaultMode), "manual");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
