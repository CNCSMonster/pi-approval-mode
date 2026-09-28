import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../extensions/permission-engine.ts";

test("PermissionManager - reloadFiles 完整保留内存态 sessionRules 并热载磁盘规则", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-perm-reload-test-"));
	const userDir = join(tempDir, "user");
	const projectDir = join(tempDir, "project");
	mkdirSync(userDir, { recursive: !0 });
	mkdirSync(join(projectDir, ".pi"), { recursive: !0 });

	try {
		// 初始写入规则
		writeFileSync(
			join(projectDir, ".pi", "approval-rules.json"),
			JSON.stringify({ allow: ["Read(*)"] }),
		);
		writeFileSync(
			join(userDir, "approval-rules.json"),
			JSON.stringify({ deny: ["Bash(rm -rf /)"] }),
		);

		const pm = new PermissionManager(projectDir, userDir);

		// 在会话期间动态添加会话级授权 (内存态)
		pm.addRule("allow", "Bash(cargo check)", "session");
		pm.addRule("ask", "Bash(npm test)", "session");

		assert.deepEqual(pm.getSessionRules().allow, ["Bash(cargo check)"]);
		assert.deepEqual(pm.getSessionRules().ask, ["Bash(npm test)"]);
		assert.deepEqual(pm.getProjectRules().allow, ["Read(*)"]);
		assert.deepEqual(pm.getUserRules().deny, ["Bash(rm -rf /)"]);

		// 修改磁盘文件 (模拟用户在外部修改或 git pull)
		writeFileSync(
			join(projectDir, ".pi", "approval-rules.json"),
			JSON.stringify({ allow: ["Read(*)", "Edit(src/*)"] }),
		);
		writeFileSync(
			join(userDir, "approval-rules.json"),
			JSON.stringify({ deny: ["Bash(rm -rf /)", "Bash(shutdown *)"] }),
		);

		// 触发 reloadFiles (/reload 契约)
		pm.reloadFiles();

		// 验证：内存态 session 规则必须 100% 完整保留！
		assert.deepEqual(pm.getSessionRules().allow, ["Bash(cargo check)"]);
		assert.deepEqual(pm.getSessionRules().ask, ["Bash(npm test)"]);

		// 验证：磁盘项目规则和全局规则成功更新
		assert.deepEqual(pm.getProjectRules().allow, ["Read(*)", "Edit(src/*)"]);
		assert.deepEqual(pm.getUserRules().deny, ["Bash(rm -rf /)", "Bash(shutdown *)"]);

		// 验证仲裁决策生效
		const checkSession = pm.evaluate({ cwd: projectDir, toolName: "bash", input: { command: "cargo check" } });
		assert.equal(checkSession.decision, "allow");

		const checkNewProject = pm.evaluate({ cwd: projectDir, toolName: "edit", input: { path: "src/main.rs" } });
		assert.equal(checkNewProject.decision, "allow");

		const checkNewDeny = pm.evaluate({ cwd: projectDir, toolName: "bash", input: { command: "shutdown -h now" } });
		assert.equal(checkNewDeny.decision, "deny");
	} finally {
		rmSync(tempDir, { recursive: !0, force: !0 });
	}
});

test("PermissionManager - 支持 initialSessionRules 状态迁移与恢复", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-perm-migrate-test-"));
	const userDir = join(tempDir, "user");
	const projectDir = join(tempDir, "project");
	mkdirSync(userDir, { recursive: !0 });
	mkdirSync(join(projectDir, ".pi"), { recursive: !0 });

	try {
		const initialSession = {
			allow: ["Bash(echo hi)"],
			ask: ["Bash(deploy)"],
			deny: ["Bash(drop database)"],
		};

		const pm = new PermissionManager(projectDir, userDir, initialSession);

		assert.deepEqual(pm.getSessionRules(), initialSession);
		assert.equal(
			pm.evaluate({ cwd: projectDir, toolName: "bash", input: { command: "drop database" } }).decision,
			"deny",
		);
		assert.equal(
			pm.evaluate({ cwd: projectDir, toolName: "bash", input: { command: "echo hi" } }).decision,
			"allow",
		);
	} finally {
		rmSync(tempDir, { recursive: !0, force: !0 });
	}
});
