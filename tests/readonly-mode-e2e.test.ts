import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import approvalModeExtension from "../extensions/approval-mode.ts";
import { resetBwrapCacheForTesting } from "../extensions/readonly-sandbox.ts";

// 环境隔离
const sandboxHome = mkdtempSync(join(tmpdir(), "pi-readonly-e2e-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

interface Harness {
	handlers: Record<string, any>;
	commands: Record<string, any>;
	shortcuts: Record<string, any>;
	activeToolsCalls: number;
	setActiveToolsCalls: number;
	dialogs: string[];
	notices: string[];
	ctx: any;
	currentTools: string[];
}

async function setup(opts: {
	hasUI?: boolean;
	initialMode?: string;
}): Promise<Harness> {
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const shortcuts: Record<string, any> = {};
	let activeToolsCalls = 0;
	let setActiveToolsCalls = 0;
	let currentTools = ["read", "bash", "edit", "write"];

	const pi = {
		registerFlag: () => {},
		registerCommand: (name: string, def: any) => {
			commands[name] = def;
		},
		registerShortcut: (key: string, def: any) => {
			shortcuts[key] = def;
		},
		getActiveTools: () => {
			activeToolsCalls++;
			return [...currentTools];
		},
		setActiveTools: (tools: string[]) => {
			setActiveToolsCalls++;
			currentTools = [...tools];
		},
		on: (event: string, handler: Function) => {
			handlers[event] = handler;
		},
		appendEntry: () => {},
		getFlag: (name: string) => (name === "approval-mode" ? opts.initialMode ?? "manual" : undefined),
	};

	approvalModeExtension(pi as any);

	const dialogs: string[] = [];
	const notices: string[] = [];

	const ctx = {
		hasUI: opts.hasUI !== false,
		cwd: process.cwd(),
		sessionManager: {
			getEntries: () => [],
		},
		ui: {
			theme: { fg: (_c: string, t: string) => t },
			custom: async (_component: any) => {
				dialogs.push("dialog");
				return "deny";
			},
			notify: (msg: string, _type: string) => {
				notices.push(msg);
			},
			setStatus: () => {},
			setWidget: () => {},
		},
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
		},
	};

	// 触发 session_start 初始化状态
	if (handlers.session_start) {
		await handlers.session_start({}, ctx);
	}

	return {
		handlers,
		commands,
		shortcuts,
		get activeToolsCalls() {
			return activeToolsCalls;
		},
		get setActiveToolsCalls() {
			return setActiveToolsCalls;
		},
		dialogs,
		notices,
		ctx,
		currentTools,
	};
}

test("模式切换与别名兼容 (/readonly, /plan, Ctrl+Alt+P)", async () => {
	const h = await setup({ hasUI: true, initialMode: "manual" });

	// 1. 使用 /readonly 切换
	await h.commands["readonly"].handler("", h.ctx);
	assert.ok(h.notices.some((n) => n.includes("readonly")));

	// 2. 切回 manual (/readonly 再次调用切换回 manual)
	await h.commands["readonly"].handler("", h.ctx);

	// 3. 使用旧命令 /plan 切换（必须作为只读模式别名）
	await h.commands["plan"].handler("", h.ctx);
	assert.ok(h.notices.some((n) => n.includes("readonly")));

	// 4. 快捷键 Ctrl+Alt+P 切换
	const toggleShortcut = h.shortcuts["ctrl+alt+p"];
	assert.ok(toggleShortcut, "必须注册 Ctrl+Alt+P 快捷键");

	// 当前为 readonly，按快捷键切回上一个模式 manual
	await toggleShortcut.handler(h.ctx);
	// 再次按快捷键进入 readonly
	await toggleShortcut.handler(h.ctx);
});

test("核心不变量——绝不调用 setActiveTools 动态扣减工具声明 (缓存与 Gemini 闭包)", async () => {
	const h = await setup({ hasUI: true, initialMode: "manual" });

	const initialSetCalls = h.setActiveToolsCalls;

	// 切换到 readonly
	await h.commands["readonly"].handler("", h.ctx);
	// 再切回 manual
	await h.commands["readonly"].handler("", h.ctx);
	// 再次切换到 readonly
	await h.commands["readonly"].handler("", h.ctx);

	// 确认整个生命周期中，绝对没有调用 setActiveTools 抠工具声明
	assert.equal(
		h.setActiveToolsCalls,
		initialSetCalls,
		"只读模式必须保持 Tools Schema 恒定暴露，严禁调用 setActiveTools 扣减工具",
	);
});

test("只读模式下 edit/write 0ms 物理阻断，零人工弹窗，返回 EROFS", async () => {
	const h = await setup({ hasUI: true, initialMode: "readonly" });

	// 1. 调用 edit
	const editResult = await h.handlers.tool_call(
		{ toolCallId: "call_1", toolName: "edit", input: { path: "src/index.ts", content: "foo" } },
		h.ctx,
	);

	assert.strictEqual(editResult.block, true, "edit 必须被拦截");
	assert.match(editResult.reason, /EROFS: read-only file system/, "返回客观 EROFS 报错");
	assert.equal(h.dialogs.length, 0, "零人工弹窗打扰，不弹出审批窗口");

	// 2. 调用 write
	const writeResult = await h.handlers.tool_call(
		{ toolCallId: "call_2", toolName: "write", input: { path: "dist/app.js", content: "bar" } },
		h.ctx,
	);

	assert.strictEqual(writeResult.block, true, "write 必须被拦截");
	assert.match(writeResult.reason, /EROFS: read-only file system/, "返回客观 EROFS 报错");
	assert.equal(h.dialogs.length, 0, "零人工弹窗打扰");
});

test("只读模式下读类工具正常放行", async () => {
	const h = await setup({ hasUI: true, initialMode: "readonly" });

	for (const tool of ["read", "grep", "find", "ls"]) {
		const res = await h.handlers.tool_call(
			{ toolCallId: `call_${tool}`, toolName: tool, input: { path: "package.json" } },
			h.ctx,
		);
		assert.strictEqual(res?.block, undefined, `${tool} 读类工具必须直接放行`);
	}
});

test("只读模式下 bash 危险命令被拦截，安全命令经沙盒包装放行", async () => {
	const h = await setup({ hasUI: true, initialMode: "readonly" });

	// 模拟 Linux bwrap 环境
	resetBwrapCacheForTesting(true);

	// 1. 危险非只读命令被拦截
	const rmRes = await h.handlers.tool_call(
		{ toolCallId: "call_rm", toolName: "bash", input: { command: "rm -rf tmp" } },
		h.ctx,
	);
	assert.strictEqual(rmRes?.block, true, "rm 命令必须被静态拦截");
	assert.match(rmRes.reason, /blocked by read-only policy/);

	// 2. 安全探查命令经 bwrap 包装后放行
	const inputSafe = { command: "git status" };
	const gitRes = await h.handlers.tool_call(
		{ toolCallId: "call_git", toolName: "bash", input: inputSafe },
		h.ctx,
	);
	assert.strictEqual(gitRes?.block, undefined, "安全只读命令必须放行");
	assert.match(inputSafe.command, /^bwrap --ro-bind/, "输入命令必须被内核级沙盒包装");

	resetBwrapCacheForTesting(undefined);
});

test("正向系统附注提醒注入且不污染历史 (context / before_agent_start)", async () => {
	const h = await setup({ hasUI: true, initialMode: "readonly" });

	// 1. context 钩子变换
	const contextEvent = {
		messages: [
			{ role: "user", content: "Please inspect the codebase architecture" },
		],
	};

	if (h.handlers.context) {
		await h.handlers.context(contextEvent, h.ctx);
		assert.match(contextEvent.messages[0].content as string, /<system-reminder>/);
		assert.match(contextEvent.messages[0].content as string, /Read-Only/);
	}

	// 2. before_agent_start 钩子 guidelines 追加
	const startEvent = {
		systemPromptOptions: {
			guidelines: ["Base guideline"],
		},
	};
	if (h.handlers.before_agent_start) {
		await h.handlers.before_agent_start(startEvent, h.ctx);
		assert.ok(startEvent.systemPromptOptions.guidelines.some((g: string) => g.includes("Read-Only")));
	}
});
