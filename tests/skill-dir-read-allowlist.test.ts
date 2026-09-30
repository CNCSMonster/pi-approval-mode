import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getToolDefaultPermission, PermissionManager } from "../extensions/permission-engine.ts";
import approvalModeExtension from "../extensions/approval-mode.ts";

// 环境隔离：HOME 重定向到临时目录（os.homedir() 在 POSIX 上读 $HOME）。
// PermissionManager 的 userDir 默认 ~/.pi/agent 亦由此推导——避免测试读写真实用户规则，
// 并保证钩子级断言不被本机已有显式规则干扰（显式 ask 规则按 I6 会压过白名单，属设计正确行为）。
process.env.HOME = mkdtempSync(join(tmpdir(), "pi-issue-0020-home-"));

test("getToolDefaultPermission 技能目录白名单逻辑", () => {
	const cwd = join(homedir(), "my-workspace", "project");
	
	// 1. 用户级恒豁免 (无论是否受信)
	assert.equal(getToolDefaultPermission("read", "~/.pi/agent/skills/a/SKILL.md", cwd, true), "allow");
	assert.equal(getToolDefaultPermission("read", "~/.agents/skills/a/SKILL.md", cwd, false), "allow");
	
	// 2. 项目级受信任时，祖先目录的 skill 被豁免
	const subCwd = join(cwd, "packages/client");
	assert.equal(getToolDefaultPermission("read", join(cwd, ".pi/skills/b/SKILL.md"), subCwd, true), "allow");
	assert.equal(getToolDefaultPermission("read", join(cwd, ".agents/skills/b/SKILL.md"), subCwd, true), "allow");
	
	// 3. 项目级未受信任时，祖先目录读取维持越界弹窗 (ask)
	assert.equal(getToolDefaultPermission("read", join(cwd, ".pi/skills/b/SKILL.md"), subCwd, false), "ask");
	
	// 4. 路径穿越与逃逸测试 (回归)
	assert.equal(getToolDefaultPermission("read", "~/.agents/skills/../../.ssh/id_rsa", cwd, true), "ask");
	
	// 5. 非读类工具直接返回 allow（走原审批漏斗，不被当前白名单逻辑拦截改写）
	assert.equal(getToolDefaultPermission("edit", "~/.agents/skills/a/SKILL.md", cwd, true), "allow");
});

test("默认层只在无显式规则命中时生效（安全不变量 I1/I6）", () => {
	const cwd = join(homedir(), "project");
	const pm = new PermissionManager(cwd, undefined, undefined, true);
	
	// 如果用户加了显式 deny 规则，evaluate 应该返回 deny，从而压过默认白名单
	pm.addRule("deny", "Read(~/.agents/skills/**)", "user");
	const resDeny = pm.evaluate({ cwd, toolName: "read", input: { path: "~/.agents/skills/my-skill/SKILL.md" } });
	assert.equal(resDeny.decision, "deny");
	
	pm.clearUserRules();
	
	// 显式 ask 规则同理
	pm.addRule("ask", "Read(~/.agents/skills/**)", "user");
	const resAsk = pm.evaluate({ cwd, toolName: "read", input: { path: "~/.agents/skills/my-skill/SKILL.md" } });
	assert.equal(resAsk.decision, "ask");

	// 收尾：清除刚写入 userDir 的规则，避免污染后续测试（或真实用户配置）
	pm.clearUserRules();
});

test("symlink 逃逸不入白名单（拍板：归一化 + 真实路径判定）", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-issue-0020-"));
	try {
		const ws = join(tmpDir, "ws");
		const outside = join(tmpDir, "outside");
		mkdirSync(join(ws, ".agents", "skills", "real-skill"), { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.md"), "secret");
		writeFileSync(join(ws, ".agents", "skills", "real-skill", "SKILL.md"), "ok");
		symlinkSync(outside, join(ws, ".agents", "skills", "evil-skill"), "dir");

		// 正例：真实文件就在项目 skill 目录内 → 豁免
		assert.equal(getToolDefaultPermission("read", join(ws, ".agents", "skills", "real-skill", "SKILL.md"), ws, true), "allow");
		// 逃逸：词法在白名单内、realpath 落在 skill 目录之外 → 不豁免（ask）
		assert.equal(getToolDefaultPermission("read", join(ws, ".agents", "skills", "evil-skill", "secret.md"), ws, true), "ask");
		// 幽灵路径（不存在）：realpath 失败 → 回退词法匹配，维持 allow（读取本就必然失败）
		assert.equal(getToolDefaultPermission("read", join(ws, ".agents", "skills", "ghost.md"), ws, true), "allow");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("钩子级 —— manual/auto-edit/auto × 交互/无头，skill 目录读取直接放行", async () => {
	for (const mode of ["manual", "auto-edit", "auto"]) {
		for (const hasUI of [true, false]) {
			const handlers: Record<string, any> = {};
			const pi = {
				registerFlag: () => {},
				registerCommand: () => {},
				registerShortcut: () => {},
				getActiveTools: () => ["read", "grep", "find", "ls", "edit", "write", "bash"],
				setActiveTools: () => {},
				on: (event: string, handler: Function) => { handlers[event] = handler; },
				appendEntry: () => {},
				getFlag: (name: string) => (name === "approval-mode" ? mode : undefined),
			};
			approvalModeExtension(pi as any);
			const ctx: any = {
				modelRegistry: { find: () => null, getAll: () => [], hasConfiguredAuth: () => false, complete: async () => ({ content: [] }) },
				model: null,
				hasUI,
				ui: { notify: () => {}, select: async () => null, theme: { fg: (_c: string, t: string) => t }, setStatus: () => {} },
				cwd: join(homedir(), "issue-0020-ws"),
				isProjectTrusted: () => true,
				sessionManager: { getBranch: () => [] },
			};
			await handlers["session_start"]({ reason: "start" }, ctx);
			const res = await handlers["tool_call"]({ toolName: "read", input: { path: "~/.agents/skills/demo/SKILL.md" } }, ctx);
			assert.equal(res, undefined, `${mode} (hasUI=${hasUI}) 下 skill 目录读取应直接放行（不弹窗、无头不阻断）`);
		}
	}
});
