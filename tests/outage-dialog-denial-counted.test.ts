import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import approvalModeExtension from "../extensions/approval-mode.ts";

// 环境隔离：HOME / USERPROFILE 重定向到 mkdtemp，绝不写真实 ~/.pi
const sandboxHome = mkdtempSync(join(tmpdir(), "pi-issue-0026-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

interface Harness {
	handlers: Record<string, any>;
	dialogs: string[];
	notices: string[];
	ctx: any;
}

// 分类器两阶段恒定运行失败（stage2_exception → decision.outage = true）的交互/无头通用脚手架。
// 命令一律取 HIGH_RISK_PATTERNS 命中项（sudo），确保走分类器分支且启发式兜底同样判定为危险。
async function setup(opts: { hasUI: boolean }): Promise<Harness> {
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
			throw new Error("model timeout");
		},
	};

	const dialogs: string[] = [];
	const notices: string[] = [];
	const ctx: any = {
		modelRegistry: registry,
		model: ctxModel,
		hasUI: opts.hasUI,
		ui: {
			notify: (m: string) => notices.push(m),
			select: async (body: string) => {
				dialogs.push(body);
				return null; // 用户在弹窗中选择拒绝（默认项）
			},
			theme: { fg: (_c: string, t: string) => t },
			setStatus: () => {},
		},
		cwd: "/test",
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	await handlers["session_start"]({ reason: "start" }, ctx);
	return { handlers, dialogs, notices, ctx };
}

const cmd = (n: number) => `sudo rm -rf /tmp/issue-0026-${n}`;

// 主断言：故障弹窗里用户亲手点的拒绝必须进拒绝侧（三处统计 + 指纹）。
// 选用的可观察信号 = loopDetector.recordDenial 与 denialTracker.recordBlock 的下游效应，
// 二者都是"拒绝侧专属"电路（不可用侧不会触发），因此 pre-fix 实现必然失败、post-fix 必然成立：
//   ① 指纹短路：交互拒绝后原样重试 → classifier_blocked_retry 文案（无指纹则拿不到）；
//   ② loop 连续被拒预警：交互弹窗正文出现"已连续被拒绝 N 次"；
//   ③ loop 连续被拒硬熔断：第 10 次调用被硬熔断、不再弹窗（拒绝不计数则永远攒不满）。
test("交互 outage 弹窗中的用户拒绝计入拒绝侧（指纹 + loop 连续被拒）", async () => {
	const ui = await setup({ hasUI: true });

	// ① 单次故障弹窗拒绝 → 指纹入账：同参重试（切无头以暴露短路文案）
	const res1 = await ui.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(1) } }, ui.ctx);
	assert.strictEqual(res1?.block, true, "outage 弹窗默认拒绝必须拦截");
	assert.strictEqual(ui.dialogs.length, 1, "第一次调用应弹出人审窗");

	ui.ctx.hasUI = false;
	const retry = await ui.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(1) } }, ui.ctx);
	assert.match(
		String(retry?.reason),
		/previously blocked this exact action/,
		"用户亲手拒绝后必须写入动作指纹，同参重试走短路（拒绝未计数则此处仍是 stage2_exception）",
	);
	ui.ctx.hasUI = true;

	// ② + ③ 连续人工拒绝 → loop 连续被拒预警与硬熔断（各次命令参数不同，排除同名同参循环干扰）
	const h = await setup({ hasUI: true });
	for (let i = 1; i <= 3; i++) {
		const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(i) } }, h.ctx);
		assert.strictEqual(r?.block, true);
	}
	assert.ok(
		h.dialogs.every((d) => !d.includes("连续被拒")),
		"三次拒绝的弹窗内不应提前出现连续被拒预警（loop 计数在阈值边界）",
	);

	const res4 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(4) } }, h.ctx);
	assert.strictEqual(res4?.block, true);
	assert.match(
		h.dialogs[h.dialogs.length - 1],
		/已连续被拒绝第 3 次|连续被拒绝 3 次/,
		"第三次人工拒绝后，第四次调用必须携带 loop 连续被拒预警（拒绝未计数则此处致盲）",
	);

	for (let i = 5; i <= 9; i++) {
		await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(i) } }, h.ctx);
	}
	const dialogsBeforeFuse = h.dialogs.length;
	const res10 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(10) } }, h.ctx);
	assert.strictEqual(res10?.block, true, "连续被拒达硬上限必须拦截");
	assert.match(String(res10?.reason), /Circuit Breaker/, "连续被拒硬熔断文案必须返回给模型");
	assert.strictEqual(h.dialogs.length, dialogsBeforeFuse, "硬熔断直接拦截，不再弹窗");
	assert.ok(h.notices.some((m) => m.includes("硬上限")), "硬熔断需会话内告警");
});

// 0024 非回归：故障的**自动**（无头）拦截只计不可用，绝不进拒绝侧。
// 若拒绝侧被污染，第 4 次无头拦截会变成 loop 熔断或 consecutive_block 文案，而不是不可用熔断。
test("回归保护: 无头 outage 自动拦截不入拒绝侧（只走不可用电路）", async () => {
	const h = await setup({ hasUI: false });

	const reasons: string[] = [];
	for (let i = 1; i <= 4; i++) {
		const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(i) } }, h.ctx);
		assert.strictEqual(r?.block, true, `第 ${i} 次无头故障拦截必须 fail-closed`);
		reasons.push(String(r?.reason));
	}

	assert.match(reasons[0], /stage2_exception/, "单次故障按故障文案返回");
	assert.doesNotMatch(reasons[1], /previously blocked this exact action/, "故障自动拦截不得写入拒绝指纹");
	assert.match(reasons[3], /classifier unavailable x3/, "连续三次不可用后第四次走不可用熔断（x3 计数）");
	assert.doesNotMatch(reasons[3], /consecutive denial limit|Circuit Breaker/, "拒绝侧电路不得被故障拦截喂满");

	for (let i = 5; i <= 10; i++) {
		const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(i) } }, h.ctx);
		assert.doesNotMatch(
			String(r?.reason),
			/Circuit Breaker/,
			"纯 outage 拦截累积到第 10 次仍不得触发 loop 连续被拒硬熔断",
		);
	}
});

// 拒绝侧与不可用侧的计数分离：弹窗被用户批准（放行）时不产生任何拒绝统计。
test("边界: outage 弹窗中用户放行不入拒绝侧", async () => {
	const h = await setup({ hasUI: true });
	const originalSelect = h.ctx.ui.select;
	h.ctx.ui.select = async (body: string) => {
		h.dialogs.push(body);
		return "1"; // 数字键 1 → allow_once（允许本次执行）
	};

	const res = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(1) } }, h.ctx);
	assert.strictEqual(res, undefined, "用户批准 outage 弹窗后应放行");

	h.ctx.ui.select = originalSelect;
	const next = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(2) } }, h.ctx);
	assert.ok(!h.dialogs[h.dialogs.length - 1].includes("连续被拒"), "放行不得累积拒绝统计");
	assert.strictEqual(next?.block, true);
});
