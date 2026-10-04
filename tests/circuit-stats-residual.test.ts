import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import approvalModeExtension from "../extensions/approval-mode.ts";

// 环境隔离：HOME / USERPROFILE 重定向到 mkdtemp，绝不写真实 ~/.pi
const sandboxHome = mkdtempSync(join(tmpdir(), "pi-issue-0027-home-"));
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

	await handlers["session_start"]({ reason: "start" }, ctx);
	return { handlers, commands, dialogs, notices, ctx, classifyCalls: () => classifyCalls };
}

const cmd = (n: number) => `sudo rm -rf /tmp/issue-0027-${n}`;

// ============================================================
// A：快路径放行不得"治愈"分类器故障计数（混合流量下不可用熔断必须仍可达）
// 翻转：auto 只读 bash 免审快路径下线——ls 同样进分类器、故障同样 fail-closed；
// 熔断可达性锚定在新口径下依然成立（三次故障来源均计入 u）。
// ============================================================
test("e2e: 混合流量（outage ×2 → 只读 bash 进分类器故障 → 触顶）不可用熔断可达", async () => {
	const h = await setup({ hasUI: false, complete: "outage" });

	for (const n of [1, 2]) {
		const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(n) } }, h.ctx);
		assert.match(String(r?.reason), /stage2_exception/, `第 ${n} 次故障拦截返回故障文案`);
	}

	// 区内只读 bash 在 auto 下一律进分类器（免审已下线）：故障 fail-closed 拦截，同样计入 u
	const callsBefore = h.classifyCalls();
	const ok = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "ls -la" } }, h.ctx);
	assert.strictEqual(ok?.block, true, "只读 bash 进分类器，故障时必须 fail-closed 拦截（不再是快路径放行）");
	assert.ok(h.classifyCalls() > callsBefore, "ls 必须真实调用分类器");

	const r3 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(3) } }, h.ctx);
	assert.match(
		String(r3?.reason),
		/classifier unavailable x3/,
		"累计第三次不可用必须触顶熔断（pre-0032：ls 快路径放行不灌 u，此处仍是 stage2_exception）",
	);
	const callsAt = h.classifyCalls();

	const r4 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(4) } }, h.ctx);
	assert.match(String(r4?.reason), /classifier unavailable x3/, "触顶后持续走 consecutive_unavailable 直拒口径");
	assert.strictEqual(h.classifyCalls(), callsAt, "触顶后不得再调用分类器");
});

// ============================================================
// B：无头 loop 拦截 reason 为熔断口径 + loop 先手于 tracker consecutive_block 的 e2e 钉住
// ============================================================
test("e2e: 无头真实连拒 3 次 → 第 4 次拦截来自 loop 熔断而非 tracker consecutive_block", async () => {
	const h = await setup({ hasUI: false, complete: "block" });

	// 三次不同参数的真实拒绝（分类器判拦 → blockCall 双灌 loop + tracker）
	for (const n of [1, 2, 3]) {
		const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(n) } }, h.ctx);
		assert.strictEqual(r?.block, true, `第 ${n} 次连拒必须拦截`);
		assert.match(String(r?.reason), /Command blocked by the safety classifier/, `第 ${n} 次为分类器拒绝文案`);
	}

	// 第 4 次：tracker 的 consecutive_block 已达阈值（b=3），但 loop 在 step -1 先手
	const r4 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(4) } }, h.ctx);
	assert.strictEqual(r4?.block, true, "第 4 次必须被拦截");
	const reason = String(r4?.reason);
	assert.match(reason, /\[Circuit Breaker\]/, "第 4 次拦截 reason 必须来自 loop 熔断（先手证据）");
	assert.match(reason, /consecutive_denials/, "熔断口径须注明连续被拒");
	assert.match(reason, /Human intervention is required/, "无头死路必须说实话：需人工介入");
	assert.doesNotMatch(reason, /consecutive denial limit on this action/, "不得是 tracker consecutive_block 文案（被先手）");
	assert.doesNotMatch(reason, /Command blocked by the safety classifier/, "第 4 次不得再进分类器");
	assert.doesNotMatch(reason, /转换策略|switch (your )?strategy|continue with unrelated/i, "不得保留'转换策略即可继续'类误导");
});

// ============================================================
// C-3：指纹命中 → 交互侧跳过分类器直接人审弹窗（M10：不重复研判）
// ============================================================
test("bash 指纹命中交互侧分类器调用计数不增、弹窗出现且携带短路文案", async () => {
	const h = await setup({ hasUI: true, complete: "block" });

	const r1 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(1) } }, h.ctx);
	assert.strictEqual(r1?.block, true, "首次分类器判拦 → 弹窗默认拒绝");
	assert.strictEqual(h.dialogs.length, 1);
	const callsAfterFirst = h.classifyCalls();
	assert.ok(callsAfterFirst >= 1, "首次必须真实经过分类器");

	// 同指纹原样重试：跳过分类器，直接呈现人审弹窗
	const r2 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(1) } }, h.ctx);
	assert.strictEqual(h.classifyCalls(), callsAfterFirst, "指纹命中不得重复调用分类器（M10 不重复研判）");
	assert.strictEqual(h.dialogs.length, 2, "仍保留人工出口：弹窗必须出现");
	assert.match(h.dialogs[1], /previously blocked this exact action/, "弹窗 reason 采用 fallback.reasonText");
	assert.match(h.dialogs[1], /重复被拦短路/, "弹窗明示跳过分类器");
	assert.strictEqual(r2?.block, true, "默认拒绝态下 Esc/默认即拒绝");
	assert.match(String(r2?.reason), /user denied/, "人审拒绝走 userDenied 文案");
});

test("受保护路径 edit 指纹命中同样跳过分类器直接人审", async () => {
	const h = await setup({ hasUI: true, complete: "block" });
	const editInput = { path: "/test/.env", content: "SECRET=1" };

	const r1 = await h.handlers["tool_call"]({ toolName: "write", input: editInput }, h.ctx);
	assert.strictEqual(r1?.block, true, "受保护路径分类器判拦 → 弹窗默认拒绝");
	const callsAfterFirst = h.classifyCalls();

	const r2 = await h.handlers["tool_call"]({ toolName: "write", input: editInput }, h.ctx);
	assert.strictEqual(h.classifyCalls(), callsAfterFirst, "protected-edit 指纹命中不得重复调用分类器");
	assert.strictEqual(h.dialogs.length, 2, "protected-edit 交互侧保留人工出口");
	assert.match(h.dialogs[1], /previously blocked this exact action/, "弹窗 reason 用 fallback.reasonText");
	assert.strictEqual(r2?.block, true);
});

// ============================================================
// C-1：total_denial 达顶 → 交互侧直接拒绝 + 解除提示（不跑分类器、不弹窗）
// ============================================================
test("交互侧会话拒绝上限达顶后直接拒绝并提示 allow 规则解除", async () => {
	// 默认 maxTotalDenials=20；用"拒绝→放行"交替把 totalBlock 灌到 20（第 1~39 次调用 = 20 拒 + 19 放，
	// 第 39 次奇数弹窗拒绝恰好凑满 20），同时避开 loop 连拒熔断（allowCall 的 recordSuccess 清零连续被拒计数）
	const h = await setup({
		hasUI: true,
		complete: "block",
		selectReply: (n) => (n % 2 === 1 ? null : "1"), // 奇数次弹窗拒绝、偶数次放行
	});

	for (let i = 1; i <= 39; i++) {
		const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(i) } }, h.ctx);
		if (i % 2 === 1) assert.strictEqual(r?.block, true, `第 ${i} 次弹窗拒绝应拦截`);
		else assert.strictEqual(r, undefined, `第 ${i} 次弹窗放行应通过`);
	}
	assert.strictEqual(h.dialogs.length, 39, "达顶前应每次经分类器+弹窗（第 39 次拒绝恰好凑满 cap 20）");
	const callsAtCap = h.classifyCalls();
	const noticesAtCap = h.notices.length;

	// 达顶后（totalBlock=20 ≥ cap 20）：不跑分类器、不弹窗，直接拒绝 + 提示
	const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(40) } }, h.ctx);
	assert.strictEqual(r?.block, true, "达顶交互侧必须直接拒绝");
	assert.match(String(r?.reason), /session denial cap/, "block reason 走 total_denial 熔断口径");
	assert.strictEqual(h.classifyCalls(), callsAtCap, "达顶后不得再调用分类器");
	assert.strictEqual(h.dialogs.length, 39, "达顶后不得再弹窗");
	assert.ok(
		h.notices.length > noticesAtCap && h.notices[h.notices.length - 1].includes("allow 规则"),
		"必须提示人可用 allow 规则解除",
	);
});

// ============================================================
// D：switchMode 同步重置 denialTracker（跨模式不带旧债）
// ============================================================
test("switchMode 重置 tracker 可观测——模式切换后旧指纹短路失效", async () => {
	const h = await setup({ hasUI: true, complete: "block" });

	// 交互拒绝一次 → consecutiveBlock=1 + pendingFingerprint 入账
	const input = { command: cmd(1) };
	const r1 = await h.handlers["tool_call"]({ toolName: "bash", input }, h.ctx);
	assert.strictEqual(r1?.block, true);

	// 切换模式两次（auto → manual → auto），switchMode 应同步 denialTracker.resetAll()
	await h.commands["approval-mode"].handler("manual", h.ctx);
	await h.commands["approval-mode"].handler("auto", h.ctx);

	// 可观测信号：同指纹在无头下重试——
	// pre-fix（不重置）：pendingFingerprint 残留 → checkFallback 返回 classifier_blocked_retry 文案；
	// post-fix（已重置）：指纹已清 → 重新进分类器，reason 为分类器拒绝口径。
	h.ctx.hasUI = false;
	const r2 = await h.handlers["tool_call"]({ toolName: "bash", input }, h.ctx);
	assert.doesNotMatch(
		String(r2?.reason),
		/previously blocked this exact action/,
		"模式切换后旧债（指纹/计数）不得带入新模式",
	);
	assert.match(String(r2?.reason), /Command blocked by the safety classifier/, "重置后从零开始重新研判");
});
