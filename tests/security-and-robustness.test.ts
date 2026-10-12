import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	isShellTool,
	matchesCommandPattern,
	PermissionManager,
	TOOL_MACROS,
} from "../extensions/permission-engine.ts";
import {
	evaluateStrictReadOnlyCommand,
	evaluateTier1StaticReadonlyGate,
	resetBwrapCacheForTesting,
} from "../extensions/readonly-sandbox.ts";
import {
	isEscapingWorkspace,
} from "../extensions/heuristic-guard.ts";
import approvalModeExtension from "../extensions/approval-mode.ts";

/**
 * 模拟 Pi Extension 测试 Harness
 */
interface MockExtensionContext {
	hasUI: boolean;
	cwd: string;
	sessionManager: {
		getEntries: () => any[];
	};
	modelRegistry: {
		find: () => any;
	};
	ui: {
		notify: (msg: string, level?: string) => void;
		confirm: (title: string, msg: string) => Promise<boolean>;
		select: (msg: string, items: string[]) => Promise<string | undefined>;
	};
}

async function setupTestExtension(options: { hasUI?: boolean; initialMode?: string; cwd?: string } = {}) {
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};
	const shortcuts: Record<string, any> = {};

	const mockPi = {
		registerFlag: () => {},
		getFlag: (name: string) => (name === "approval-mode" ? options.initialMode ?? "manual" : undefined),
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => {},
		appendEntry: () => {},
		on: (event: string, handler: Function) => {
			handlers[event] = handler;
		},
		registerCommand: (name: string, def: any) => {
			commands[name] = def;
		},
		registerShortcut: (key: string, def: any) => {
			shortcuts[key] = def;
		},
	};

	approvalModeExtension(mockPi as any);

	const cwd = options.cwd || process.cwd();
	const ctx: MockExtensionContext = {
		hasUI: options.hasUI !== false,
		cwd,
		sessionManager: {
			getEntries: () => [],
		},
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
		} as any,
		ui: {
			theme: { fg: (_c: string, t: string) => t },
			custom: async () => "deny",
			notify: () => {},
			confirm: async () => false,
			select: async () => undefined,
			setStatus: () => {},
			setWidget: () => {},
		} as any,
	};

	if (handlers.session_start) {
		await handlers.session_start({}, ctx);
	}

	return { handlers, commands, ctx };
}

// =========================================================================
// Module A: Shell 抽象统一与 PowerShell 覆盖
// =========================================================================

test("Shell 抽象统一与多 Shell 工具识别", () => {
	assert.strictEqual(isShellTool("bash"), true);
	assert.strictEqual(isShellTool("powershell"), true);
	assert.strictEqual(isShellTool("pwsh"), true);
	assert.strictEqual(isShellTool("cmd"), true);
	assert.strictEqual(isShellTool("run_shell_command"), true);
	assert.strictEqual(isShellTool("BASH"), true);
	assert.strictEqual(isShellTool("PowerShell"), true);

	assert.strictEqual(isShellTool("read"), false);
	assert.strictEqual(isShellTool("edit"), false);
	assert.strictEqual(isShellTool("write"), false);
	assert.strictEqual(isShellTool("custom_tool"), false);

	// TOOL_MACROS.bash 包含常见 shell 命名
	assert.ok(TOOL_MACROS.bash.includes("powershell"));
	assert.ok(TOOL_MACROS.bash.includes("pwsh"));
	assert.ok(TOOL_MACROS.bash.includes("run_shell_command"));
});

test("manual 模式下 powershell 命令纳入 Shell 审批体系", async () => {
	const h = await setupTestExtension({ hasUI: false, initialMode: "manual" });

	// 无头模式下 powershell 必须被拦截而不是被静默漏过
	const res = await h.handlers.tool_call(
		{ toolCallId: "call_ps1", toolName: "powershell", input: { command: "Get-Process" } },
		h.ctx,
	);
	assert.strictEqual(res?.block, true);
	assert.match(res?.reason || "", /powershell|Get-Process/);
});

// =========================================================================
// Module B: 命令通配符操作符分段与命令替换防御
// =========================================================================

test("matchesCommandPattern 阻断操作符级联拼接注入", () => {
	// 单独安全命令匹配
	assert.strictEqual(matchesCommandPattern("git status", "git status*"), true);

	// 操作符级联命令：所有子命令段必须全部匹配 pattern
	assert.strictEqual(matchesCommandPattern("git status && rm -rf /", "git status*"), false);
	assert.strictEqual(matchesCommandPattern("git status; rm -rf /", "git status*"), false);
	assert.strictEqual(matchesCommandPattern("git status || echo 'hacked'", "git status*"), false);
	assert.strictEqual(matchesCommandPattern("git status & evil_task", "git status*"), false);
	assert.strictEqual(matchesCommandPattern("git status | cat", "git status*"), false);

	// 两段均匹配的情况
	assert.strictEqual(matchesCommandPattern("git status && git status -s", "git status*"), true);

	// 引号内包含操作符不是真分段
	assert.strictEqual(matchesCommandPattern('echo "hello && world"', "echo *"), true);
	assert.strictEqual(matchesCommandPattern("git commit -m 'feat; fix'", "git commit*"), true);
});

test("matchesCommandPattern 阻断命令替换 $(...) 与反引号逃逸", () => {
	// pattern 为具体命令时，不可包含未放行的命令替换
	assert.strictEqual(matchesCommandPattern("echo $(cat /etc/passwd)", "echo safe"), false);
	assert.strictEqual(matchesCommandPattern("git log `cat /etc/passwd`", "git log*"), false);

	// 通配符 * 允许匹配任意参数
	assert.strictEqual(matchesCommandPattern("echo $(cat /etc/passwd)", "*"), true);
});

// =========================================================================
// Module C: ReadOnly 沙盒与白名单加固 (重定向、git 参数、破坏性指令)
// =========================================================================

test("evaluateStrictReadOnlyCommand 放行无害标准错误与静音重定向", () => {
	assert.strictEqual(evaluateStrictReadOnlyCommand("git status 2>/dev/null").isSafe, true);
	assert.strictEqual(evaluateStrictReadOnlyCommand("ls -la 2> /dev/null").isSafe, true);
	assert.strictEqual(evaluateStrictReadOnlyCommand("cat package.json >/dev/null").isSafe, true);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git status > /dev/null 2>&1").isSafe, true);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git status 2>NUL").isSafe, true);

	// 真实文件写入重定向仍坚决拦截
	assert.strictEqual(evaluateStrictReadOnlyCommand("git status > output.txt").isSafe, false);
	assert.strictEqual(evaluateStrictReadOnlyCommand("ls >> file.log").isSafe, false);
});

test("evaluateStrictReadOnlyCommand 穿透解析 git 全局参数", () => {
	assert.strictEqual(evaluateStrictReadOnlyCommand("git -C /some/path status").isSafe, true);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git --no-pager diff").isSafe, true);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git -c color.ui=always log").isSafe, true);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git --work-tree=/app status").isSafe, true);

	// 穿透解析出破坏性 git 命令拦截
	assert.strictEqual(evaluateStrictReadOnlyCommand("git -C /tmp branch -D main").isSafe, false);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git --no-pager tag -d v1.0").isSafe, false);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git remote rm origin").isSafe, false);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git remote add evil http://evil.com").isSafe, false);
});

// =========================================================================
// Module D: 第三方及外部 MCP 工具安全兜底
// =========================================================================

test("readonly 模式下物理阻断未识别的外部 MCP 工具", async () => {
	const h = await setupTestExtension({ hasUI: true, initialMode: "readonly" });

	const res = await h.handlers.tool_call(
		{ toolCallId: "call_mcp1", toolName: "mcp_deploy_service", input: { target: "prod" } },
		h.ctx,
	);
	assert.strictEqual(res?.block, true);
	assert.match(res?.reason || "", /not a recognized read-only exploration tool/);
});

test("manual 模式下外部 MCP 工具在无头环境中物理拦截", async () => {
	const h = await setupTestExtension({ hasUI: false, initialMode: "manual" });

	const res = await h.handlers.tool_call(
		{ toolCallId: "call_mcp2", toolName: "custom_thirdparty_tool", input: { action: "run" } },
		h.ctx,
	);
	assert.strictEqual(res?.block, true);
	assert.match(res?.reason || "", /requires human approval in headless mode/);
});

// =========================================================================
// Module E: 并发互斥、系统附注幂等与工作区软链接误判修复
// =========================================================================

test("context 事件钩子对只读系统附注幂等注入", async () => {
	const h = await setupTestExtension({ hasUI: true, initialMode: "readonly" });

	const messages = [
		{ role: "user", content: "Please explain the architecture." },
	];

	// 第一次触发 context 事件
	await h.handlers.context({ messages });
	assert.ok(messages[0].content.includes("Environment Mode: Read-Only"));

	const contentAfterFirst = messages[0].content;

	// 多次重复触发 context 事件（同一轮中多次回调）
	await h.handlers.context({ messages });
	await h.handlers.context({ messages });

	// 不得重复追加
	assert.strictEqual(messages[0].content, contentAfterFirst);
	const matches = messages[0].content.match(/Environment Mode: Read-Only/g);
	assert.strictEqual(matches?.length, 1);
});

test("isEscapingWorkspace 支持软链接工作区根目录不发生误报", () => {
	const tempBase = mkdtempSync(join(tmpdir(), "pi-issue0055-symlink-"));
	try {
		const realWorkspace = join(tempBase, "real-project");
		mkdirSync(realWorkspace);
		const targetFile = join(realWorkspace, "src", "index.ts");
		mkdirSync(join(realWorkspace, "src"));
		writeFileSync(targetFile, "console.log('hi');");

		const linkWorkspace = join(tempBase, "symlink-project");
		symlinkSync(realWorkspace, linkWorkspace);

		// 通过软链接工作区路径访问其内部文件，不能被误判为逃逸越权
		const escaping = isEscapingWorkspace(linkWorkspace, targetFile);
		assert.strictEqual(escaping, false);

		// 真正越界逃逸到 tempBase 外的系统文件仍被正确判定为越权
		const realEscape = isEscapingWorkspace(linkWorkspace, "/etc/passwd");
		assert.strictEqual(realEscape, true);
	} finally {
		rmSync(tempBase, { recursive: true, force: true });
	}
});

// =========================================================================
// 收敛修复 (2026-10-11): P0 deny/ask 复合命令聚合语义回归、
// P1 Tier 1 沙盒层序归位、P2 git 创建型写操作拦截
// =========================================================================

test("复合命令 deny/ask 按任一段聚合，allow 按全段聚合", () => {
	// deny 语义 (any): 任一子命令段命中即算匹配，复合命令不得绕过阻断
	assert.strictEqual(matchesCommandPattern("git status && rm -rf /", "git status", "any"), true);
	assert.strictEqual(matchesCommandPattern("ls && rm -rf /", "rm *", "any"), true);
	assert.strictEqual(matchesCommandPattern("rm -rf / && git status", "rm *", "any"), true);

	// allow 语义 (all，默认): 全部子段命中才放行，防止借前缀 allow 规则逃逸
	assert.strictEqual(matchesCommandPattern("git status && rm -rf /", "git status"), false);
	assert.strictEqual(matchesCommandPattern("git status; rm -rf /", "git *"), false);
	assert.strictEqual(matchesCommandPattern("git status && git diff", "git *"), true);

	// 命令替换在 allow 池（all）直接不命中；deny 池（any）不因此跳过评估
	assert.strictEqual(matchesCommandPattern("echo $(cat /etc/passwd)", "echo *"), false);
});

test("PermissionManager 状态机——复合命令无法借 allow 逃逸 deny", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-issue0055-deny-semantics-"));
	try {
		const pm = new PermissionManager(tmp, tmp);
		pm.addRule("deny", "Bash(rm *)", "session");
		pm.addRule("allow", "Bash(git *)", "session");

		// deny 命中任一子段 → deny 压过 allow（旧版全段聚合下会漏拦）
		const r1 = pm.evaluate({
			cwd: tmp,
			toolName: "bash",
			input: { command: "git status && rm -rf /" },
		});
		assert.strictEqual(r1.decision, "deny");

		// allow 仅在全段命中时生效
		const r2 = pm.evaluate({
			cwd: tmp,
			toolName: "bash",
			input: { command: "git status && git diff" },
		});
		assert.strictEqual(r2.decision, "allow");

		// 复合命令含非 allow 段 → 不得 allow，回落 default（交审批模式处理）
		const r3 = pm.evaluate({
			cwd: tmp,
			toolName: "bash",
			input: { command: "git status && python -V" },
		});
		assert.strictEqual(r3.decision, "default");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("Tier 1 静态门——复杂探查放行交沙盒，写意图与远程副作用拦截", () => {
	// 核心样例：只读探查不再被 Tier 2 白名单提前扼杀
	assert.strictEqual(evaluateTier1StaticReadonlyGate("python test.py").isSafe, true);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("pytest -q").isSafe, true);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("cargo check").isSafe, true);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("git status").isSafe, true);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("echo hi > /dev/null").isSafe, true);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("curl https://example.com/api").isSafe, true);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("npm test").isSafe, true);

	// 本地写意图：0ms 清晰归因
	assert.strictEqual(evaluateTier1StaticReadonlyGate("rm -rf tmp").isSafe, false);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("echo hi > /tmp/f").isSafe, false);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("gcc x.c").isSafe, false);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("sed -i 's/a/b/' f.txt").isSafe, false);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("find . -delete").isSafe, false);
	assert.strictEqual(evaluateTier1StaticReadonlyGate(`git log | awk '{system("id")}'`).isSafe, false);

	// 沙盒无法约束的远程 / 会话副作用
	assert.strictEqual(evaluateTier1StaticReadonlyGate("git push origin main").isSafe, false);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("npm publish").isSafe, false);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("ssh host ls").isSafe, false);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("curl -X POST https://example.com").isSafe, false);
	assert.strictEqual(evaluateTier1StaticReadonlyGate("docker run alpine").isSafe, false);
});

test("readonly 下 Tier 1 沙盒优先——python test.py 包裹执行而非白名单拦截", async () => {
	resetBwrapCacheForTesting(true);
	try {
		const h = await setupTestExtension({ hasUI: false, initialMode: "readonly" });
		const input = { command: "python test.py" };
		const res = await h.handlers.tool_call(
			{ toolCallId: "call_py", toolName: "bash", input },
			h.ctx,
		);
		assert.strictEqual(res?.block, undefined, "Tier 1 下 python test.py 不得被白名单提前拦截");
		assert.match(
			input.command,
			/^(bwrap --ro-bind|sandbox-exec)/,
			"命令必须被内核级只读沙盒包裹执行",
		);

		// 写意图命令在 Tier 1 下仍被静态拦截（快速归因）
		const rmRes = await h.handlers.tool_call(
			{ toolCallId: "call_rm2", toolName: "bash", input: { command: "rm -rf tmp" } },
			h.ctx,
		);
		assert.strictEqual(rmRes?.block, true, "Tier 1 下写意图命令必须被静态拦截");
	} finally {
		resetBwrapCacheForTesting(undefined);
	}
});

test("Tier 2 白名单拦截 git 创建型写操作与 --output 落盘", () => {
	// 创建型 / 变更型写操作拦截
	assert.strictEqual(evaluateStrictReadOnlyCommand("git branch feature-x").isSafe, false);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git -C . branch hotfix").isSafe, false);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git tag v1.0.0").isSafe, false);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git tag -a v1 -m msg").isSafe, false);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git config user.name evil").isSafe, false);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git log --output=/tmp/out.txt").isSafe, false);

	// 查询类操作仍放行
	assert.strictEqual(evaluateStrictReadOnlyCommand("git branch --list 'feature/*'").isSafe, true);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git tag --points-at HEAD").isSafe, true);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git remote get-url origin").isSafe, true);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git config --get user.name").isSafe, true);
	assert.strictEqual(evaluateStrictReadOnlyCommand("git log --oneline").isSafe, true);
});
