/**
 * tests/issue-0053-upstream-error-diagnostics.test.ts
 *
 * 分类器上游 403 锁区与异常排障诊断端到端测试
 */

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import approvalModeExtension from "../extensions/approval-mode.ts";
import {
	getRecentLogs,
	clearRecentLogs,
} from "../extensions/logger.ts";

const sandboxHome = mkdtempSync(join(tmpdir(), "pi-issue-0053-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

interface Harness {
	handlers: Record<string, any>;
	dialogs: string[];
	notices: Array<{ msg: string; type: string }>;
	ctx: any;
	setQueue: (q: any[]) => void;
}

async function setup(opts: { hasUI: boolean }): Promise<Harness> {
	const handlers: Record<string, any> = {};
	const pi = {
		registerFlag: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		getActiveTools: () => ["bash", "edit", "read"],
		setActiveTools: () => {},
		on: (event: string, handler: Function) => {
			handlers[event] = handler;
		},
		appendEntry: () => {},
		getFlag: (name: string) => (name === "approval-mode" ? "auto" : undefined),
	};
	approvalModeExtension(pi as any);

	const ctxModel = { provider: "test-provider", id: "test-model" };
	let queue: any[] = [];
	const registry = {
		models: [ctxModel],
		find: () => null,
		getAll: () => [ctxModel] as any[],
		hasConfiguredAuth: () => true,
		complete: async () => {
			const act = queue.shift();
			if (act instanceof Error) {
				throw act;
			}
			if (typeof act === "function") {
				return act();
			}
			return act ?? { content: [{ type: "text", text: '{"shouldBlock": false}' }] };
		},
	};

	const dialogs: string[] = [];
	const notices: Array<{ msg: string; type: string }> = [];
	const ctx: any = {
		modelRegistry: registry,
		model: ctxModel,
		hasUI: opts.hasUI,
		ui: {
			notify: (msg: string, type: string) => notices.push({ msg, type }),
			select: async (promptBody: string) => {
				dialogs.push(promptBody);
				return "5. Block (Esc)";
			},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
			setStatus: () => {},
			setWidget: () => {},
		},
		cwd: "/test",
		isProjectTrusted: () => true,
		sessionManager: { getEntries: () => [] },
	};

	await handlers["session_start"]({ reason: "start" }, ctx);
	return { handlers, dialogs, notices, ctx, setQueue: (q) => { queue = q; } };
}

const dangerousCmd = "sudo rm -rf /var/log/app.log";

test("Stage 2 捕获 403 锁区异常，透传 shortCode 与 UI notify 及控制台日志", async () => {
	clearRecentLogs();
	const h = await setup({ hasUI: false });
	const err403 = new Error("Request failed with status code 403: Region not supported in your country");
	(err403 as any).status = 403;

	// Stage 1 fast check 抛错流转 Stage 2，Stage 2 也抛出 403
	h.setQueue([err403, err403]);

	const res = await h.handlers["tool_call"]({ toolName: "bash", input: { command: dangerousCmd } }, h.ctx);
	assert.strictEqual(res?.block, true, "fail-closed 阻断");
	const reason = String(res?.reason);
	assert.match(reason, /upstream_403\(Region Blocked\)/, "reason 必须透传结构化错误短码");
	assert.match(reason, /bash/, "包含受影响工具名");

	// 检查排障日志（写入安全文件日志记录器，杜绝直写控制台破坏 TUI）
	const logs = getRecentLogs();
	assert.ok(logs.some((l) => l.includes("[ApprovalMode] 分类器 Stage 2 请求异常") && l.includes("403")));
	assert.ok(logs.some((l) => l.includes("网络代理分流规则")));
});

test("交互模式下 403 锁区异常触发 UI Notify 并在审批弹窗展示 🔧 排障建议", async () => {
	const h = await setup({ hasUI: true });
	const err403 = new Error("403 Forbidden: Access Denied by Cloudflare");

	h.setQueue([err403, err403]);

	await h.handlers["tool_call"]({ toolName: "bash", input: { command: dangerousCmd } }, h.ctx);

	// 1. UI Notify 告警
	const notifyErr = h.notices.find((n) => n.type === "error" && n.msg.includes("Region Blocked"));
	assert.ok(notifyErr, "必须向 UI 发出 error 级别的地域锁区通知");
	assert.match(notifyErr.msg, /网络代理分流/);

	// 2. 审批弹窗详情包含排障建议
	assert.strictEqual(h.dialogs.length, 1, "必须弹出审批窗口");
	const promptBody = h.dialogs[0];
	assert.match(promptBody, /🔧 排障建议/, "弹窗文本必须包含 🔧 排障建议 字段");
	assert.match(promptBody, /海外支持区域节点/);
});

test("401 凭据失效透传 upstream_401(Auth Failed) 并给出 API Key 检查建议", async () => {
	const h = await setup({ hasUI: true });
	const err401 = new Error("Unauthorized: Invalid API Key");
	(err401 as any).statusCode = 401;

	h.setQueue([err401, err401]);

	await h.handlers["tool_call"]({ toolName: "bash", input: { command: dangerousCmd } }, h.ctx);

	const notifyAuth = h.notices.find((n) => n.type === "error" && n.msg.includes("Auth Failed"));
	assert.ok(notifyAuth, "必须向 UI 发出 401 认证失败通知");
	assert.match(notifyAuth.msg, /API Key/);

	const promptBody = h.dialogs[0];
	assert.match(promptBody, /🔧 排障建议/, "弹窗必须包含排障建议");
	assert.match(promptBody, /检查 API Key 是否有效/);
});

test("Stage 2 超时分支打印排障日志并在弹窗中呈现代理检查建议", async () => {
	clearRecentLogs();
	const h = await setup({ hasUI: true });

	// stage1 抛错触发流转 Stage 2，Stage 2 挂起模拟超时 (由 withTimeout 返回 null)
	h.setQueue([
		new Error("Stage 1 failure"),
		() => new Promise((resolve) => setTimeout(resolve, 5000)), // 模拟挂起
	]);

	await h.handlers["tool_call"]({ toolName: "bash", input: { command: dangerousCmd } }, h.ctx);

	const logs = getRecentLogs();
	assert.ok(logs.some((w) => w.includes("分类器 Stage 2 超时") && w.includes("可能由代理网络挂起或阻塞引起")));

	const promptBody = h.dialogs[0];
	assert.match(promptBody, /🔧 排障建议/);
	assert.match(promptBody, /检查代理服务是否正常转发/);
});
