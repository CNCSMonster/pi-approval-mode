import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import approvalModeExtension from "../extensions/approval-mode.ts";
// 通过命名空间访问新导出，改码前该导出为 undefined（调用即抛错 → 干净地红），不会导致整文件 import 失败。
import * as approvalModule from "../extensions/approval-mode.ts";

// 环境隔离：HOME / USERPROFILE → mkdtemp，绝不写真实 ~/.pi；配置一律经项目级 .pi/approval-config.json 注入。
const sandboxHome = mkdtempSync(join(tmpdir(), "pi-ctc-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

type CompleteMode = "throw" | "hang" | "allow";

interface E2E {
	handlers: Record<string, any>;
	ctx: any;
	notices: string[];
	warns: string[];
	debugs: string[];
}

// 在临时 cwd 写项目级配置并驱动 session_start；console.warn/debug 与 ctx.ui.notify 全部捕获。
async function startWithConfig(config: Record<string, unknown>, complete: CompleteMode): Promise<E2E> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ctc-cwd-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "approval-config.json"), JSON.stringify(config), "utf-8");

	const handlers: Record<string, any> = {};
	const pi = {
		registerFlag: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		getActiveTools: () => ["bash", "edit"],
		setActiveTools: () => {},
		on: (event: string, handler: Function) => {
			handlers[event] = handler;
		},
		appendEntry: () => {},
		getFlag: (name: string) => (name === "approval-mode" ? "auto" : undefined),
	};
	approvalModeExtension(pi as any);

	const ctxModel = { provider: "ctx", id: "main" };
	const registry = {
		models: [ctxModel],
		find: () => null,
		getAll: () => [ctxModel] as any[],
		hasConfiguredAuth: () => true,
		complete: async () => {
			if (complete === "throw") throw new Error("model timeout");
			if (complete === "hang") return new Promise(() => {}); // 永不 resolve → 走超时分支
			return { content: [{ type: "text", text: '{"shouldBlock": false}' }] };
		},
	};

	const notices: string[] = [];
	const warns: string[] = [];
	const debugs: string[] = [];
	const ctx: any = {
		modelRegistry: registry,
		model: ctxModel,
		hasUI: false,
		ui: {
			notify: (m: string) => notices.push(m),
			select: async () => null,
			theme: { fg: (_c: string, t: string) => t },
			setStatus: () => {},
		},
		cwd,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	const ow = console.warn;
	const od = console.debug;
	console.warn = (...a: any[]) => warns.push(a.join(" "));
	console.debug = (...a: any[]) => debugs.push(a.join(" "));
	try {
		await handlers["session_start"]({ reason: "start" }, ctx);
	} finally {
		console.warn = ow;
		console.debug = od;
	}
	return { handlers, ctx, notices, warns, debugs };
}

// 危险命令：越过只读快路径，进入两阶段分类器。
const DANGER = "sudo rm -rf /tmp/ctc-fixture";

// 纯函数 spy：捕获 console.warn/debug（用于 C3/C5/C6 直接注入 JS 原生值，含 JSON 无法表达的 NaN）。
function callApply(fileConfig: any): { ret: any; warns: string[]; debugs: string[]; notified: string[] } {
	const apply = (approvalModule as any).applyClassifierTimeoutConfig;
	const warns: string[] = [];
	const debugs: string[] = [];
	const notified: string[] = [];
	const ctx = { ui: { notify: (m: string) => notified.push(m) } };
	const ow = console.warn;
	const od = console.debug;
	console.warn = (...a: any[]) => warns.push(a.join(" "));
	console.debug = (...a: any[]) => debugs.push(a.join(" "));
	try {
		var ret = apply(fileConfig, ctx);
	} finally {
		console.warn = ow;
		console.debug = od;
	}
	return { ret, warns, debugs, notified };
}

// ============================================================
// C1 默认：两字段缺省 → effective 1500/3000；既有故障 reason 口径不受影响
// ============================================================
test("C1 默认：缺省 effective 1500/3000 且故障 reason 口径不变", async () => {
	const h = await startWithConfig({}, "throw");
	assert.strictEqual(h.warns.length, 0, "缺省不应告警");
	assert.ok(
		h.debugs.some((d) => /stage1=1500ms/.test(d) && /stage2=3000ms/.test(d)),
		`effective 应为 1500/3000，实得: ${JSON.stringify(h.debugs)}`,
	);
	const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: DANGER } }, h.ctx);
	assert.strictEqual(r?.block, true, "分类器故障应 fail-closed");
	assert.match(String(r?.reason), /stage2_exception/, "既有故障 reason 口径不得改变");
});

// ============================================================
// C2 stage2 独立生效：仅设两字段合法小值对 → 真超时 reason = stage2_timeout(<有效stage2>ms)
// 500/600 合法，约 0.6s 耗时可控。pre-fix：新字段被忽略，stage2 用 500×2=1000ms → reason 1000ms（红）
// ============================================================
test("C2 stage2 独立生效：真超时 reason 为 stage2_timeout(600ms)", async () => {
	const h = await startWithConfig({ classifierTimeoutMs: 500, classifierStage2TimeoutMs: 600 }, "hang");
	assert.strictEqual(h.warns.length, 0, "500/600 合法不应告警");
	const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: DANGER } }, h.ctx);
	assert.match(String(r?.reason), /stage2_timeout\(600ms\)/, `stage2 超时应为独立值 600ms，实得: ${r?.reason}`);
});

// ============================================================
// C3 stage1 派生：仅设 stage1 → stage2 派生 ×2，不告警且 stage1 生效
// ============================================================
test("C3 stage1 派生：stage1=3000 → stage2 派生 6000 且不告警", () => {
	const { ret, warns } = callApply({ classifierTimeoutMs: 3000 });
	assert.strictEqual(ret.stage1, 3000, "stage1 应生效为 3000");
	assert.strictEqual(ret.stage2, 6000, "stage2 应派生为 stage1×2=6000");
	assert.strictEqual(ret.violated, false, "派生不应视为违规");
	assert.strictEqual(warns.length, 0, "不应告警");
});

// ============================================================
// C4 关系违规：显式 stage2 ≤ stage1 → 告警 + ctx.ui.notify + 双双回退 1500/3000（经载入路径 e2e 验证）
// ============================================================
test("C4 关系违规：stage1=5000 + stage2=3000 → 告警并整对回退默认", async () => {
	const h = await startWithConfig({ classifierTimeoutMs: 5000, classifierStage2TimeoutMs: 3000 }, "throw");
	assert.ok(h.warns.length >= 1, "关系违规必须触发 console.warn");
	assert.ok(
		h.notices.some((n) => /classifierStage2TimeoutMs/.test(n)),
		"载入点应经 ctx.ui.notify 发出一次告警",
	);
	assert.ok(
		h.debugs.some((d) => /stage1=1500ms/.test(d) && /stage2=3000ms/.test(d)),
		`违规后 effective 应回退 1500/3000，实得: ${JSON.stringify(h.debugs)}`,
	);
});

// ============================================================
// C5 边界非法逐值：各自独立 → 告警 + effective 回退默认
// ============================================================
test("C5 边界非法逐值：各非法值独立触发告警并回退 1500/3000", () => {
	const bad = [0, -1, 0.5, NaN, Infinity, 1e999, 2147483648, "5000"];
	for (const v of bad) {
		const { ret, warns } = callApply({ classifierTimeoutMs: v });
		assert.strictEqual(ret.violated, true, `值 ${String(v)} 应判违规`);
		assert.strictEqual(ret.stage1, 1500, `值 ${String(v)} 应回退 stage1=1500`);
		assert.strictEqual(ret.stage2, 3000, `值 ${String(v)} 应回退 stage2=3000`);
		assert.ok(warns.length >= 1, `值 ${String(v)} 应告警`);
	}
});

// ============================================================
// C6 上界：stage1 60000 合法 / 60001 违规；stage2 600000 合法 / 600001 违规
// ============================================================
test("C6 上界：stage1/stage2 边界两侧行为", () => {
	const s1ok = callApply({ classifierTimeoutMs: 60000 });
	assert.strictEqual(s1ok.ret.violated, false, "stage1=60000 应合法");
	assert.strictEqual(s1ok.ret.stage1, 60000);

	const s1bad = callApply({ classifierTimeoutMs: 60001 });
	assert.strictEqual(s1bad.ret.violated, true, "stage1=60001 应违规");
	assert.strictEqual(s1bad.ret.stage1, 1500);

	// stage2 上界（stage1 用默认 1500，令 stage2 单独贴边）
	const s2ok = callApply({ classifierStage2TimeoutMs: 600000 });
	assert.strictEqual(s2ok.ret.violated, false, "stage2=600000 应合法");
	assert.strictEqual(s2ok.ret.stage2, 600000);

	const s2bad = callApply({ classifierStage2TimeoutMs: 600001 });
	assert.strictEqual(s2bad.ret.violated, true, "stage2=600001 应违规");
	assert.strictEqual(s2bad.ret.stage2, 3000);
});
