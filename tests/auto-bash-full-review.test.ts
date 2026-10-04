import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import approvalModeExtension from "../extensions/approval-mode.ts";
import { SECURITY_POLICY_RULES, CLASSIFIER_BASE_PROMPT } from "../extensions/heuristic-guard.ts";

// 环境隔离：HOME / USERPROFILE 重定向到 mkdtemp，绝不写真实 ~/.pi
const sandboxHome = mkdtempSync(join(tmpdir(), "pi-auto-bash-full-review-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

interface Harness {
	handlers: Record<string, any>;
	commands: Record<string, any>;
	dialogs: string[];
	notices: string[];
	ctx: any;
	classifyCalls: () => number;
}

// 可编程分类器：complete = "allow"（放行）| "block"（两阶段判拦）| "outage"（complete 抛异常）
async function setup(opts: {
	hasUI: boolean;
	complete: "allow" | "block" | "outage";
	cwd?: string;
	selectReply?: (n: number) => string | null; // 第 n 次弹窗的应答（null/undefined → 默认拒绝）
}): Promise<Harness> {
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const pi = {
		registerFlag: () => {},
		registerCommand: (name: string, def: any) => {
			commands[name] = def;
		},
		registerShortcut: () => {},
		getActiveTools: () => ["bash", "edit"],
		setActiveTools: () => {},
		on: (event: string, handler: Function) => {
			handlers[event] = handler;
		},
		appendEntry: () => {},
		// 显式 CLI 参数最高优先：强制 auto（隔离共享配置残留的 defaultMode）
		getFlag: (name: string) => (name === "approval-mode" ? "auto" : undefined),
	};
	approvalModeExtension(pi as any);

	const ctxModel = { provider: "ctx", id: "main" };
	let classifyCalls = 0;
	const registry = {
		models: [ctxModel],
		find: () => null,
		getAll: () => [ctxModel] as any[],
		hasConfiguredAuth: () => true,
		complete: async () => {
			classifyCalls++;
			if (opts.complete === "outage") throw new Error("model timeout");
			const text =
				opts.complete === "block"
					? '{"shouldBlock": true, "reason": "unsafe test command"}'
					: '{"shouldBlock": false}';
			return { content: [{ type: "text", text }] };
		},
	};

	const dialogs: string[] = [];
	const notices: string[] = [];
	let selectCount = 0;
	const ctx: any = {
		modelRegistry: registry,
		model: ctxModel,
		hasUI: opts.hasUI,
		ui: {
			notify: (m: string) => notices.push(m),
			select: async (body: string) => {
				dialogs.push(body);
				selectCount++;
				return opts.selectReply ? opts.selectReply(selectCount) : null; // 默认拒绝
			},
			theme: { fg: (_c: string, t: string) => t },
			setStatus: () => {},
		},
		cwd: opts.cwd ?? mkdtempSync(join(tmpdir(), "pi-auto-bash-full-review-cwd-")),
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	await handlers["session_start"]({ reason: "start" }, ctx);
	return { handlers, commands, dialogs, notices, ctx, classifyCalls: () => classifyCalls };
}

const callBash = async (h: Harness, command: string) =>
	await h.handlers["tool_call"]({ toolName: "bash", input: { command } }, h.ctx);

// ============================================================
// A1–A5：auto 模式 bash 只读免审下线——非规则命中、非降级态的 bash 一律进分类器
// ============================================================

test("A1: auto 下 ls 不再免审快路径，进入分类器", async () => {
	const h = await setup({ hasUI: false, complete: "allow" });
	const r = await callBash(h, "ls -la");
	assert.strictEqual(h.classifyCalls(), 1, "ls 必须经过分类器研判（一次调用）");
	assert.strictEqual(r, undefined, "分类器判安全 → 放行");
});

test("A2: auto 下 git status 不再免审快路径，进入分类器", async () => {
	const h = await setup({ hasUI: false, complete: "allow" });
	const r = await callBash(h, "git status");
	assert.strictEqual(h.classifyCalls(), 1, "git status 必须经过分类器研判");
	assert.strictEqual(r, undefined, "分类器判安全 → 放行");
});

test("A3: auto 下 gcc 编译命令（无输出检查即写 a.out）进入分类器", async () => {
	const h = await setup({ hasUI: false, complete: "allow" });
	const r = await callBash(h, "gcc x.c");
	assert.strictEqual(h.classifyCalls(), 1, "gcc 必须经过分类器研判（编译器出白名单）");
	assert.strictEqual(r, undefined, "分类器判安全 → 放行");
});

test("A4: auto 下 awk system() 管道进入分类器", async () => {
	const h = await setup({ hasUI: false, complete: "allow" });
	const r = await callBash(h, `git log | awk '{system("id")}'`);
	assert.strictEqual(h.classifyCalls(), 1, "awk 管道必须经过分类器研判（awk 出管道过滤器白名单）");
	assert.strictEqual(r, undefined, "分类器判安全 → 放行");
});

test("A5: auto 下读取 ssh 私钥进入分类器（断言进分类器，非被拦）", async () => {
	const h = await setup({ hasUI: false, complete: "allow" });
	const r = await callBash(h, "cat ~/.ssh/id_rsa");
	assert.strictEqual(h.classifyCalls(), 1, "cat ~/.ssh/id_rsa 必须经过分类器研判");
	assert.strictEqual(r, undefined, "分类器判安全 → 放行（本用例只钉『进分类器』）");
});

// ============================================================
// A6：回归——step0 规则快路径不动：allow 命中仍零分类器；deny 压过一切
// ============================================================

test("A6: allow 规则命中的 bash 仍走 0.0s 快路径，deny 规则压过一切", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-auto-bash-rules-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "approval-rules.json"),
		JSON.stringify({ allow: ["Bash(git status)"], ask: [], deny: ["Bash(ls *)"], default: [] }),
		"utf-8",
	);
	const h = await setup({ hasUI: false, complete: "allow", cwd });

	const ok = await callBash(h, "git status");
	assert.strictEqual(ok, undefined, "allow 规则命中 → 免审放行");
	assert.strictEqual(h.classifyCalls(), 0, "allow 快路径不得调用分类器（step0 不动）");

	const denied = await callBash(h, "ls -la");
	assert.strictEqual(denied?.block, true, "deny 规则必须压过一切（含只读命令）");
	assert.strictEqual(h.classifyCalls(), 0, "deny 命中不得调用分类器");
});

// ============================================================
// A7：回归（拍板 3）——降级态（u≥3）bash 维持 fallbackHeuristicCheck：良性放行、危险拦截
// ============================================================

test("A7: 熔断降级态 bash 走启发式兜底——良性放行、危险拦截弹窗，分类器零调用", async () => {
	// 前 3 次故障弹窗全部放行 → u=3 触顶（allow 不治愈 u）
	const h = await setup({ hasUI: true, complete: "outage", selectReply: (n) => (n <= 3 ? "1" : null) });

	for (const n of [1, 2, 3]) {
		const r = await callBash(h, `sudo rm -rf /tmp/full-review-${n}`);
		assert.strictEqual(r, undefined, `第 ${n} 次故障人审弹窗放行`);
	}
	const callsAt = h.classifyCalls();
	assert.ok(callsAt > 0, "前三次应真实经过分类器（故障注入）");

	// 良性只读命令：降级态启发式判良性 → 放行，绝不回灌分类器
	const benign = await callBash(h, "ls -la");
	assert.strictEqual(benign, undefined, "降级态良性 bash 启发式放行");
	assert.strictEqual(h.classifyCalls(), callsAt, "降级态不得再调用分类器");

	// 危险命令：降级态启发式命中 → 拦截弹窗（0017 矩阵：危→弹人），默认拒绝出口
	const danger = await callBash(h, "sudo shutdown -h now");
	assert.strictEqual(danger?.block, true, "降级态危险 bash 必须拦截（默认拒绝态）");
	assert.strictEqual(h.dialogs.length, 4, "危险命令须呈现人审弹窗");
	assert.match(h.dialogs[3], /高危|启发式|shutdown/, "弹窗须为启发式高危口径");
	assert.strictEqual(h.classifyCalls(), callsAt, "危险分支同样不得调用分类器");
});

// ============================================================
// A8/A9：plan 模式 a/b 加固——编译器与 awk 不再是只读守卫
// ============================================================

test("A8: plan 下 gcc 编译命令被硬拦（编译器出只读白名单）", async () => {
	const h = await setup({ hasUI: false, complete: "allow" });
	await h.commands["approval-mode"].handler("plan", h.ctx);

	const r = await callBash(h, "gcc x.c");
	assert.strictEqual(r?.block, true, "plan 下 gcc x.c 必须判非只读并拦截");
});

test("A9: plan 下 awk system() 管道被硬拦（awk 出管道过滤器白名单）", async () => {
	const h = await setup({ hasUI: false, complete: "allow" });
	await h.commands["approval-mode"].handler("plan", h.ctx);

	const r = await callBash(h, `git log | awk '{system("id")}'`);
	assert.strictEqual(r?.block, true, "plan 下 awk system() 管道必须判非只读并拦截");
});

// ============================================================
// A10：destructive_git_operations 软拦词条撤除——单一来源与 prompt 快照同步干净
// ============================================================

test("A10: 策略词条无 destructive_git_operations，分类器基础 prompt 不含该软拦语义", () => {
	assert.ok(
		SECURITY_POLICY_RULES.every((r) => r.id !== "destructive_git_operations"),
		"SECURITY_POLICY_RULES 不得再包含 destructive_git_operations",
	);
	assert.ok(
		!SECURITY_POLICY_RULES.some((r) => r.promptText.includes("force-push")),
		"策略词条 promptText 不得残留 force-push 语义",
	);
	assert.doesNotMatch(CLASSIFIER_BASE_PROMPT, /force-push/, "基础 prompt 不得残留 force-push 软拦文案");
	assert.doesNotMatch(CLASSIFIER_BASE_PROMPT, /Destructive git operations/, "基础 prompt 不得残留破坏性 git 词条");
});

// ============================================================
// A11：分析调用与弹窗展示行保留——auto 分类器判拦弹窗仍含"静态结构特征"
// ============================================================

test("A11: auto 分类器判拦弹窗保留静态结构特征展示行（分析调用未下线）", async () => {
	const h = await setup({ hasUI: true, complete: "block" });

	const r = await callBash(h, "ls -la");
	assert.ok(h.classifyCalls() >= 1, "必须经过分类器研判");
	assert.strictEqual(h.dialogs.length, 1, "判拦 → 人审弹窗");
	assert.match(h.dialogs[0], /静态结构特征/, "弹窗展示行必须保留（展示≠裁决）");
	assert.strictEqual(r?.block, true, "默认拒绝出口不变");
});
