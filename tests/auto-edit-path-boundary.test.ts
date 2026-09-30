import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProtectedPath, isEscapingWorkspace } from "../extensions/heuristic-guard.ts";
import { PermissionManager } from "../extensions/permission-engine.ts";
import approvalModeExtension from "../extensions/approval-mode.ts";

// 环境隔离：HOME 重定向，防本机真实用户规则/配置干扰钩子级断言（同批次隔离惯例）
process.env.HOME = mkdtempSync(join(tmpdir(), "pi-issue-0021-home-"));

test("symlink 逃逸不豁免（normalize 后判断）", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-issue-0021-"));
	try {
		const workspace = join(tmpDir, "workspace");
		const outside = join(tmpDir, "outside");
		mkdirSync(workspace, { recursive: true });
		mkdirSync(outside, { recursive: true });
		
		writeFileSync(join(outside, "target.txt"), "hello");
		symlinkSync(join(outside, "target.txt"), join(workspace, "link.txt"));

		// link.txt is inside workspace, but points outside.
		assert.equal(isEscapingWorkspace(workspace, "link.txt"), true);
		
		// Normal file inside workspace
		writeFileSync(join(workspace, "normal.txt"), "hello");
		assert.equal(isEscapingWorkspace(workspace, "normal.txt"), false);
		
		// Unresolved outside path
		assert.equal(isEscapingWorkspace(workspace, "../outside/target.txt"), true);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("受保护路径识别回归", () => {
	assert.equal(isProtectedPath(".git/config"), true);
	assert.equal(isProtectedPath(".pi/approval-rules.json"), true);
	assert.equal(isProtectedPath(".bashrc"), true);
	assert.equal(isProtectedPath("id_rsa"), true);
	assert.equal(isProtectedPath("src/normal.ts"), false);
});

test("显式 deny/ask 规则仍压过边界，显式 allow 不压过受保护路径", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-issue-0021-perm-"));
	try {
		const pm = new PermissionManager(tmpDir);

		pm.addRule("deny", "Edit(/src/banned.ts)", "session");
		pm.addRule("ask", "Edit(/src/ask.ts)", "session");
		pm.addRule("allow", "Edit(.git/config)", "session");
		pm.addRule("allow", "Edit(/outside.txt)", "session");

		const r1 = pm.evaluate({
			cwd: tmpDir,
			toolName: "edit",
			input: { path: "src/banned.ts" }
		});
		assert.equal(r1.decision, "deny");

		const r2 = pm.evaluate({
			cwd: tmpDir,
			toolName: "edit",
			input: { path: "src/ask.ts" }
		});
		assert.equal(r2.decision, "ask");

		const r3 = pm.evaluate({
			cwd: tmpDir,
			toolName: "edit",
			input: { path: ".git/config" }
		});
		assert.equal(r3.decision, "allow"); // logic in Step 3 of mode funnel bypasses allow

	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// 钩子级：验收“auto-edit 弹窗/免审回归/无头 block”三条（tool_call 端到端）
test("钩子级 auto-edit 边界弹窗、区内免审回归与无头 block", async () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-issue-0021-hook-"));
	const tmpWs = join(tmpDir, "ws");
	mkdirSync(tmpWs, { recursive: true });
	const setup = async (hasUI: boolean) => {
		const handlers: Record<string, any> = {};
		let selectCalls = 0;
		const pi = {
			registerFlag: () => {},
			registerCommand: () => {},
			registerShortcut: () => {},
			getActiveTools: () => ["read", "edit", "write", "bash"],
			setActiveTools: () => {},
			on: (event: string, handler: Function) => { handlers[event] = handler; },
			appendEntry: () => {},
			getFlag: (name: string) => (name === "approval-mode" ? "auto-edit" : undefined),
		};
		approvalModeExtension(pi as any);
		const ctx: any = {
			modelRegistry: { find: () => null, getAll: () => [], hasConfiguredAuth: () => false, complete: async () => ({ content: [] }) },
			model: null,
			hasUI,
			ui: { notify: () => {}, select: async () => { selectCalls++; return null; }, theme: { fg: (_c: string, t: string) => t }, setStatus: () => {} },
			cwd: tmpWs,
			isProjectTrusted: () => true,
			sessionManager: { getBranch: () => [] },
		};
		await handlers["session_start"]({ reason: "start" }, ctx);
		return { handlers, ctx, select: () => selectCalls };
	};
	try {
		// 1) 受保护路径（区内）→ 人审弹窗，默认拒绝 → block
		const a = await setup(true);
		const r1 = await a.handlers["tool_call"]({ toolName: "edit", input: { path: join(tmpWs, ".bashrc") } }, a.ctx);
		assert.ok(a.select() >= 1, "受保护路径必须弹人审");
		assert.strictEqual(r1?.block, true, "null 选择默认拒绝");

		// 2) 区外非受保护 → 人审弹窗
		const b = await setup(true);
		const r2 = await b.handlers["tool_call"]({ toolName: "edit", input: { path: join(tmpDir, "outside.txt") } }, b.ctx);
		assert.ok(b.select() >= 1, "区外 edit 必须弹人审");
		assert.strictEqual(r2?.block, true);

		// 3) 区内常规文件 → 免审放行（回归，不弹窗）
		const c = await setup(true);
		const r3 = await c.handlers["tool_call"]({ toolName: "edit", input: { path: join(tmpWs, "src", "normal.ts") } }, c.ctx);
		assert.strictEqual(r3, undefined, "区内非受保护 edit 仍免审");
		assert.strictEqual(c.select(), 0);

		// 4) 无头 + 受保护 → 硬阻断（文案含 Protected-path）
		const d = await setup(false);
		const r4 = await d.handlers["tool_call"]({ toolName: "edit", input: { path: join(tmpWs, ".bashrc") } }, d.ctx);
		assert.strictEqual(r4?.block, true);
		assert.match(String(r4?.reason), /Protected-path|out-of-workspace/i);

		// 5) write 分支同边界（验收点位 :1527）
		const e = await setup(true);
		const r5 = await e.handlers["tool_call"]({ toolName: "write", input: { path: join(tmpDir, "outside.txt"), content: "x" } }, e.ctx);
		assert.ok(e.select() >= 1, "区外 write 必须弹人审");
		assert.strictEqual(r5?.block, true);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
