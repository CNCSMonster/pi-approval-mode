import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import approvalModeExtension from "../extensions/approval-mode.ts";

// 环境隔离：HOME / USERPROFILE 重定向到 mkdtemp，绝不写真实 ~/.pi
const sandboxHome = mkdtempSync(join(tmpdir(), "pi-protected-degrade-home-"));
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

// 可编程分类器：mode = "block"（两阶段一致返回 shouldBlock:true）| "outage"（complete 抛异常）
async function setup(opts: {
	hasUI: boolean;
	complete: "block" | "outage";
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
		// 显式 CLI 参数最高优先：强制 auto（隔离共享 /tmp/agent 配置残留的 defaultMode）
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
			return {
				content: [{ type: "text", text: '{"shouldBlock": true, "reason": "unsafe test mutation"}' }],
			};
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
		cwd: "/test",
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	const agentDir = join(sandboxHome, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "approval-config.json"),
		JSON.stringify({ denialLimits: { maxTotalDenials: 20 } }),
	);

	await handlers["session_start"]({ reason: "start" }, ctx);
	return { handlers, commands, dialogs, notices, ctx, classifyCalls: () => classifyCalls };
}

// 受保护路径 write：同一路径、递增 content —— 指纹逐次不同，避免撞 ③ 的短路分支
const winput = (n: number) => ({ path: "/test/.env", content: `SECRET=${n}` });

async function callWrite(h: Harness, n: number) {
	return await h.handlers["tool_call"]({ toolName: "write", input: winput(n) }, h.ctx);
}

// ============================================================
// D1：不可用熔断触顶（u≥3）→ ② 跳过分类器直呈人工核准，默认拒绝态
// ============================================================
test("受保护路径熔断降级 D1: u≥3 时分类器零调用、熔断弹窗出现、默认拒绝出口", async () => {
	// 前三次故障弹窗全部放行 → u=1..3（allow 不治愈 u，语义）
	const h = await setup({ hasUI: true, complete: "outage", selectReply: (n) => (n <= 3 ? "1" : null) });

	for (const i of [1, 2, 3]) {
		const r = await callWrite(h, i);
		assert.strictEqual(r, undefined, `第 ${i} 次故障弹窗选"允许本次"应放行`);
	}
	const callsAt = h.classifyCalls();
	assert.ok(callsAt > 0, "前三次应真实经过分类器（故障注入）");

	const r4 = await callWrite(h, 4);
	assert.strictEqual(h.classifyCalls(), callsAt, "u 触顶后第 4 次不得再调用分类器");
	assert.strictEqual(h.dialogs.length, 4, "第 4 次必须走熔断人审弹窗（人工出口保留）");
	assert.match(h.dialogs[3], /熔断/, "弹窗标题/正文须明示熔断降级");
	assert.match(h.dialogs[3], /跳过分类器/, "弹窗须说明已跳过分类器");
	assert.strictEqual(r4?.block, true, "默认拒绝态：无应答即拒绝");
	assert.match(String(r4?.reason), /user denied/, "人审拒绝走 userDenied 文案");
});

// ============================================================
// D2：同 D1 触顶态，用户在熔断弹窗中明确 allow → 放行仍有效
// ============================================================
test("受保护路径熔断降级 D2: u≥3 熔断弹窗中选 allow 仍放行（人工授权压倒降级路径）", async () => {
	const h = await setup({ hasUI: true, complete: "outage", selectReply: () => "1" });

	for (const i of [1, 2, 3]) {
		const r = await callWrite(h, i);
		assert.strictEqual(r, undefined, `第 ${i} 次放行`);
	}
	const callsAt = h.classifyCalls();

	const r4 = await callWrite(h, 4);
	assert.strictEqual(h.classifyCalls(), callsAt, "触顶后不得再调用分类器");
	assert.strictEqual(h.dialogs.length, 4, "第 4 次须出现熔断人审弹窗");
	assert.match(h.dialogs[3], /熔断/, "弹窗须为熔断降级窗");
	assert.strictEqual(r4, undefined, "用户在熔断弹窗中明确 allow → 放行");
});

// ============================================================
// D3（回归）：u<3 → 分类器照常被调用，不进 ②
// ============================================================
test("受保护路径熔断降级 D3: u<3 时分类器照常研判，弹窗为既有分类器审批窗", async () => {
	const h = await setup({ hasUI: true, complete: "block" });

	const r = await callWrite(h, 1);
	assert.ok(h.classifyCalls() >= 1, "u<3 必须真实调用分类器");
	assert.strictEqual(h.dialogs.length, 1, "分类器判拦 → 既有审批弹窗");
	assert.match(h.dialogs[0], /受保护敏感路径修改审批/, "标题保持既有分类器审批窗口径");
	assert.doesNotMatch(h.dialogs[0], /熔断/, "u<3 不得出现熔断降级窗");
	assert.strictEqual(r?.block, true, "弹窗默认拒绝 → 拦截");
});

// ============================================================
// D4（优先级）：total 达顶 ∧ u≥3 → ① 直拒优先，不弹熔断窗、不调分类器
// ============================================================
test("受保护路径熔断降级 D4: 会话拒绝上限达顶优先于不可用熔断——直拒、不弹窗、不调分类器", async () => {
	// 前 3 个弹窗放行（灌 u 到 3）；此后 2 拒 1 放循环：totalBlock 增长且避开 loop 连拒熔断
	const h = await setup({
		hasUI: true,
		complete: "outage",
		selectReply: (n) => (n <= 3 || n % 3 === 1 ? "1" : null),
	});

	let capped: { callsAt: number; dialogsAt: number; noticesAt: number; r: any } | null = null;
	for (let i = 1; i <= 100; i++) {
		const callsAt = h.classifyCalls();
		const dialogsAt = h.dialogs.length;
		const noticesAt = h.notices.length;
		const r = await callWrite(h, 100 + i);
		if (r?.block && /session denial cap/.test(String(r.reason))) {
			capped = { callsAt, dialogsAt, noticesAt, r };
			break;
		}
	}

	assert.ok(capped, "100 次内必须命中 total_denial 达顶直拒");
	assert.strictEqual(h.classifyCalls(), capped!.callsAt, "达顶后不得再调用分类器");
	assert.strictEqual(h.dialogs.length, capped!.dialogsAt, "达顶直拒不得弹窗（① 先于 ②，含熔断窗）");
	assert.ok(
		h.notices.length > capped!.noticesAt && h.notices[h.notices.length - 1].includes("allow 规则"),
		"必须提示人可用 allow 规则解除",
	);
});

// ============================================================
// D5（回归）：u<3 + 指纹命中 → ③ C-3 弹窗标题不变
// ============================================================
test("受保护路径熔断降级 D5: u<3 指纹命中仍走重复被拦短路弹窗，标题口径不变", async () => {
	const h = await setup({ hasUI: true, complete: "block" });
	const input = winput(1);

	const r1 = await h.handlers["tool_call"]({ toolName: "write", input }, h.ctx);
	assert.strictEqual(r1?.block, true, "首次分类器判拦 → 弹窗默认拒绝");
	const callsAfterFirst = h.classifyCalls();
	assert.ok(callsAfterFirst >= 1, "首次必须真实经过分类器");

	const r2 = await h.handlers["tool_call"]({ toolName: "write", input }, h.ctx);
	assert.strictEqual(h.classifyCalls(), callsAfterFirst, "指纹命中不得重复调用分类器");
	assert.strictEqual(h.dialogs.length, 2, "指纹命中仍保留人工出口");
	assert.match(h.dialogs[1], /重复被拦敏感路径修改人工核准/, "③ 弹窗标题不变");
	assert.doesNotMatch(h.dialogs[1], /熔断/, "非熔断态不得出现降级文案");
	assert.strictEqual(r2?.block, true);
});

// ============================================================
// D6（回归）：无头 + u≥3 → 既有 checkFallback 拦路径不变（统计只推 u）
// ============================================================
test("受保护路径熔断降级 D6: 无头 u≥3 走既有不可用熔断直拒，不灌拒绝侧、不进分类器", async () => {
	const h = await setup({ hasUI: false, complete: "outage" });

	for (const i of [1, 2, 3]) {
		const r = await callWrite(h, i);
		assert.strictEqual(r?.block, true, `第 ${i} 次故障自动拦截`);
		assert.match(String(r?.reason), /stage2_exception/, `第 ${i} 次为分类器故障口径`);
	}
	const callsAt = h.classifyCalls();

	const r4 = await callWrite(h, 4);
	assert.strictEqual(r4?.block, true, "u 触顶无头必须直拒");
	assert.match(String(r4?.reason), /classifier unavailable x3/, "走 consecutive_unavailable 直拒口径");
	assert.strictEqual(h.classifyCalls(), callsAt, "触顶后不得再调用分类器");

	// 熔断自拦不灌拒绝侧（countAsDenial=false）：第 5 次仍是 unavailable 口径、仍在熔断直拒
	// （触顶后分类器不再被调用，u 冻结在 3），且不被 loop 熔断先手
	// （若拒绝侧计数被灌，连拒 3 次后拦截会变为 [Circuit Breaker] / consecutive_block 口径）
	const r5 = await callWrite(h, 5);
	assert.match(String(r5?.reason), /classifier unavailable x3/, "持续走 consecutive_unavailable 直拒口径");
	assert.strictEqual(h.classifyCalls(), callsAt, "熔断直拒期间分类器调用数冻结");
	assert.doesNotMatch(String(r5?.reason), /consecutive denial limit/, "不得被拒绝侧计数挤掉 kind");
	assert.doesNotMatch(String(r5?.reason), /Circuit Breaker/, "熔断自拦不得喂 loop 连拒计数");
});

// ============================================================
// D7：loop 预警态 + 熔断触顶 → ② 弹窗携带死循环预警行，Esc/默认即拒绝
// ============================================================
test("受保护路径熔断降级 D7: loop 预警态下熔断弹窗携带死循环预警行，默认拒绝出口不变", async () => {
	// 前三次故障弹窗全部拒绝 → u=3 ∧ loop 连拒=3（第 4 次进入 isLoop 非硬上限预警态）
	const h = await setup({ hasUI: true, complete: "outage", selectReply: () => null });

	for (const i of [1, 2, 3]) {
		const r = await callWrite(h, i);
		assert.strictEqual(r?.block, true, `第 ${i} 次故障弹窗默认拒绝 → 拦截`);
	}
	const callsAt = h.classifyCalls();

	const r4 = await callWrite(h, 4);
	assert.strictEqual(h.classifyCalls(), callsAt, "触顶后不得再调用分类器");
	assert.strictEqual(h.dialogs.length, 4, "第 4 次须出现熔断人审弹窗");
	assert.match(h.dialogs[3], /熔断/, "弹窗须为熔断降级窗");
	assert.match(h.dialogs[3], /死循环预警/, "loop 预警态下熔断窗须含死循环预警行");
	assert.match(h.dialogs[3], /高危预警[\s\S]*保护路径熔断降级/, "标题降级子类型须为熔断降级口径");
	assert.strictEqual(r4?.block, true, "默认拒绝态：Esc/无应答即拒绝");
});
