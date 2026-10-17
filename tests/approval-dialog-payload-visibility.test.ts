/**
 * 审批弹窗工具信息可见性契约测试套件
 *
 * 验证核心能力（人审防线信息完整性）：
 * 1. 事实载荷恒展示：edit 的匹配/替换文本对、write 的写入内容、shell 命令全文在人工审批弹窗首屏可直达
 * 2. 主体显式选择：调用点 primary 标记优先于"最长项"启发式，短命令不被长 AI 转述挤出主体视图
 * 3. 矮终端布局数学：H=10/12/15/24/40 折叠态总高不破目标高度，且任何高度都有 m 全量详情出口
 * 4. 按键语义诚实：m 任意状态可用、详情面板为浏览态（Esc 不触发拒绝）、数字键在浏览态不直接提交
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import approvalModeExtension, {
	selectPrimaryDetailIndex,
	allocateContentViewport,
} from "../extensions/approval-mode.ts";

interface SetupOptions {
	terminalRows?: number;
	mode?: "manual" | "auto" | "auto-edit";
	toolName?: string;
	input?: Record<string, any> | ((cwd: string) => Record<string, any>);
	classifierResult?: any;
	/** 分类器恒抛错 → stage2_exception 降级链（fallback 触发链专用） */
	classifierThrows?: boolean;
	/** 预置项目级规则（会话启动前写入 <cwd>/.pi/approval-rules.json） */
	rules?: { ask?: string[]; allow?: string[]; deny?: string[]; default?: string[] };
}

async function setupDialogHarness(options: SetupOptions = {}) {
	const terminalRows = options.terminalRows ?? 40;
	const harnessCwd = mkdtempSync(join(tmpdir(), "pi-payload-visibility-"));
	if (options.rules) {
		mkdirSync(join(harnessCwd, ".pi"), { recursive: true });
		writeFileSync(join(harnessCwd, ".pi", "settings.json"), "{}", "utf-8");
		writeFileSync(
			join(harnessCwd, ".pi", "approval-rules.json"),
			JSON.stringify({ allow: [], ask: [], deny: [], default: [], ...options.rules }),
			"utf-8",
		);
	}
	let renderedComponent: any = null;
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};

	let submittedAction: any = null;

	const pi = {
		registerFlag: () => {},
		registerCommand: (name: string, def: any) => {
			commands[name] = def;
		},
		registerShortcut: () => {},
		getActiveTools: () => ["bash", "edit", "write"],
		setActiveTools: () => {},
		on: (event: string, handler: Function) => {
			handlers[event] = handler;
		},
		appendEntry: () => {},
		getFlag: () => undefined,
	};
	approvalModeExtension(pi as any);

	const ctxModel = { provider: "ctx", id: "main" };
	const registry = {
		models: [ctxModel],
		find: () => null,
		getAll: () => [ctxModel] as any[],
		hasConfiguredAuth: () => true,
		complete:
			options.classifierThrows === true
				? async () => {
						throw new Error("model timeout");
					}
				: async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify(
						options.classifierResult ?? {
							shouldBlock: true,
							reason: "触碰高危系统目录",
							summary: "执行命令",
						},
					),
				},
			],
		}),
	};

	let resolveCustom: (v: any) => void;
	const customFinished = new Promise((r) => {
		resolveCustom = r;
	});

	const mockExtensionContext: any = {
		modelRegistry: registry,
		model: ctxModel,
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				const theme = {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				};
				const tui = {
					terminal: { rows: terminalRows, columns: 80 },
					requestRender: () => {},
				};
				renderedComponent = factory(tui, theme, {}, (action: any) => {
					submittedAction = action;
					resolveCustom(action);
				});
				return customFinished;
			},
			notify: () => {},
			select: async () => null,
		},
		cwd: harnessCwd,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	await handlers["session_start"]({ reason: "start" }, mockExtensionContext);
	if (commands["approval-mode"]) {
		await commands["approval-mode"].handler(options.mode ?? "manual", mockExtensionContext);
	}

	const resolvedInput =
		typeof options.input === "function" ? options.input(harnessCwd) : (options.input ?? { command: "echo hello" });
	const promise = handlers["tool_call"](
		{ toolName: options.toolName ?? "bash", input: resolvedInput },
		mockExtensionContext,
	);

	while (!renderedComponent) {
		await new Promise((r) => setImmediate(r));
	}

	return {
		comp: renderedComponent,
		promise,
		getSubmittedAction: () => submittedAction,
	};
}

// ============================================================
// 1. 事实载荷恒展示（edit/write 载荷不得缺席人审弹窗）
// ============================================================

test("事实载荷恒展示: manual edit 弹窗可见匹配/替换文本对", async () => {
	const h = await setupDialogHarness({
		terminalRows: 40,
		toolName: "edit",
		input: {
			path: "/tmp/demo.ts",
			edits: [{ oldText: "const alpha = 1;", newText: "const alpha = 2;" }],
		},
	});
	const text = h.comp.render(80).join("\n");
	assert.ok(text.includes("修改载荷"), "弹窗必须包含修改载荷条目");
	assert.ok(text.includes("const alpha = 1;"), "匹配文本必须可见");
	assert.ok(text.includes("const alpha = 2;"), "替换文本必须可见");
});

test("事实载荷恒展示: manual write 弹窗可见完整写入内容", async () => {
	const h = await setupDialogHarness({
		terminalRows: 40,
		toolName: "write",
		input: {
			path: "/tmp/target.txt",
			content: "PAYLOAD_LINE_ONE\nPAYLOAD_LINE_TWO",
		},
	});
	const text = h.comp.render(80).join("\n");
	assert.ok(text.includes("修改载荷"), "弹窗必须包含修改载荷条目");
	assert.ok(text.includes("PAYLOAD_LINE_ONE"), "写入内容首行必须可见");
	assert.ok(text.includes("PAYLOAD_LINE_TWO"), "写入内容次行必须可见");
});

test("事实载荷恒展示: auto 受保护路径拦截弹窗可见修改载荷", async () => {
	const h = await setupDialogHarness({
		terminalRows: 40,
		mode: "auto",
		toolName: "edit",
		input: {
			path: "/etc/hosts",
			edits: [{ oldText: "127.0.0.1 localhost", newText: "127.0.0.1 evil.example" }],
		},
		classifierResult: {
			shouldBlock: true,
			reason: "尝试篡改系统 hosts 文件",
			summary: "高危写操作尝试",
		},
	});
	const text = h.comp.render(80).join("\n");
	assert.ok(text.includes("修改载荷"), "分类器拦截弹窗必须包含修改载荷条目");
	assert.ok(text.includes("127.0.0.1 evil.example"), "篡改目标内容必须可见（人审需见事实而非仅 AI 转述）");
});

// ============================================================
// 2. 主体显式选择（短载荷不被长转述挤出）
// ============================================================

test("主体显式选择: primary 标记优先于最长项启发式", () => {
	const details = [
		{ label: "拦截原因", content: "x".repeat(300) },
		{ label: "降级说明", content: "y".repeat(200) },
		{ label: "准备执行命令", content: "id", primary: true },
	];
	assert.equal(selectPrimaryDetailIndex(details), 2, "primary 标记的短命令必须被选为主体");
	// 无 primary 标记时回退最长项（兼容旧调用点）
	const legacy = [
		{ label: "拦截原因", content: "short" },
		{ label: "调用参数", content: "y".repeat(100) },
	];
	assert.equal(selectPrimaryDetailIndex(legacy), 1);
});

test("主体显式选择: 短命令 + 长 AI 转述时命令仍是主体代码视图", async () => {
	const h = await setupDialogHarness({
		terminalRows: 40,
		mode: "auto",
		input: { command: "id" },
		classifierResult: {
			shouldBlock: true,
			reason: "这是一段非常非常长的拦截理由转述文本。".repeat(8),
			summary: "这是一段非常非常长的操作摘要转述文本。".repeat(4),
		},
	});
	const lines = h.comp.render(80);
	const text = lines.join("\n");
	assert.ok(text.includes("准备执行命令:"), "命令条目标签必须可见");
	assert.ok(text.includes("id"), "短命令内容必须在首屏可见");
	// 命令是主体（紧随其标签行），而非被转述文本顶替
	const labelIdx = lines.findIndex((l: string) => l.includes("准备执行命令:"));
	assert.ok(labelIdx >= 0 && labelIdx < lines.length - 1, "命令标签后必须有正文行");
});

// ============================================================
// 3. 矮终端布局数学（总高不破目标 + m 出口恒在）
// ============================================================

test("布局数学: 内容槽位分配代入极值核算 (H=10/12/15/24/40)", () => {
	// 锁定态 H=10 → 槽位 1：标签内联单行，事实载荷恒有一行可见
	let plan = allocateContentViewport(1, { wantMetaPreview: true, hasPrimary: true, maxMetaLines: 1 });
	assert.deepEqual(plan, { metaLines: 0, heroLabelLines: 0, heroLines: 1, inlineLabel: true });
	// 锁定态 H=12 → 槽位 3：标签 + 头尾双行
	plan = allocateContentViewport(3, { wantMetaPreview: true, hasPrimary: true, maxMetaLines: 1 });
	assert.deepEqual(plan, { metaLines: 0, heroLabelLines: 1, heroLines: 2, inlineLabel: false });
	// 锁定态 H=15 → 槽位 6：meta 预览 1 + 标签 + 折叠正文 4
	plan = allocateContentViewport(6, { wantMetaPreview: true, hasPrimary: true, maxMetaLines: 1 });
	assert.deepEqual(plan, { metaLines: 1, heroLabelLines: 1, heroLines: 4, inlineLabel: false });
	// H=24 紧凑态 → 槽位 14：meta 预览 1 + 标签 + 12
	plan = allocateContentViewport(14, { wantMetaPreview: true, hasPrimary: true, maxMetaLines: 1 });
	assert.deepEqual(plan, { metaLines: 1, heroLabelLines: 1, heroLines: 12, inlineLabel: false });
	// H=40 标准态 → 槽位 23：meta 预览 2 + 标签 + 20
	plan = allocateContentViewport(23, { wantMetaPreview: true, hasPrimary: true, maxMetaLines: 2 });
	assert.deepEqual(plan, { metaLines: 2, heroLabelLines: 1, heroLines: 20, inlineLabel: false });
	// 零槽位：全部为零，出口交给 m 面板
	plan = allocateContentViewport(0, { wantMetaPreview: true, hasPrimary: true, maxMetaLines: 1 });
	assert.deepEqual(plan, { metaLines: 0, heroLabelLines: 0, heroLines: 0, inlineLabel: false });
	// 无主体：槽位全给 meta 预览
	plan = allocateContentViewport(4, { wantMetaPreview: true, hasPrimary: false, maxMetaLines: 2 });
	assert.deepEqual(plan, { metaLines: 2, heroLabelLines: 0, heroLines: 0, inlineLabel: false });
});

test("布局数学: 折叠态总高恒不超过目标高度 (H=10/12/15/24/40)", async () => {
	for (const h of [10, 12, 15, 24, 40]) {
		const harness = await setupDialogHarness({
			terminalRows: h,
			mode: "auto",
			input: { command: Array.from({ length: 30 }, (_, i) => `echo "step ${i + 1}"`).join("\n") },
			classifierResult: {
				shouldBlock: true,
				reason: "触碰高危系统目录 /etc",
				summary: "执行命令",
				diagnosticHint: "检查模型余额与网关配置",
			},
		});
		const lines = harness.comp.render(80);
		const target = h < 16 ? h : h - 1;
		assert.ok(
			lines.length <= target,
			`H=${h} 折叠态总高 (${lines.length}) 必须 <= 目标高度 (${target})`,
		);
		// 选项区必须完整（人审可操作是底线）
		const text = lines.join("\n");
		assert.ok(text.includes("拒绝执行"), `H=${h} 选项区必须完整可见`);
	}
});

test("矮终端出口: H=12 长命令经 m 面板可见全文，再按 m 切回", async () => {
	const cmd = Array.from({ length: 30 }, (_, i) => `echo "payload line ${i + 1}"`).join("\n");
	const h = await setupDialogHarness({
		terminalRows: 12,
		input: { command: cmd },
	});
	let text = h.comp.render(80).join("\n");
	// 首屏紧凑形态：至少命令首行或内联形态可见
	assert.ok(text.includes("payload line 1"), "首屏必须可见命令首行（或内联紧凑形态）");

	h.comp.handleInput("m");
	text = h.comp.render(80).join("\n");
	assert.ok(text.includes("全量详情面板"), "m 必须在折叠态打开全量详情面板");
	assert.ok(text.includes("payload line 1"), "面板首页可见命令起始部分");

	// End 直跳底部：命令尾部必须可达（载荷不得有永远看不到的部分）
	h.comp.handleInput("G");
	text = h.comp.render(80).join("\n");
	assert.ok(text.includes("payload line 30"), "End 直跳后命令末行必须可见");

	h.comp.handleInput("m");
	text = h.comp.render(80).join("\n");
	assert.ok(!text.includes("全量详情面板"), "再按 m 切回代码视图");
});

test("极矮终端出口: H=10 仍有信息出口且总高不超 H", async () => {
	const cmd = Array.from({ length: 10 }, (_, i) => `echo "tiny line ${i + 1}"`).join("\n");
	const h = await setupDialogHarness({ terminalRows: 10, input: { command: cmd } });
	let lines = h.comp.render(80);
	assert.ok(lines.length <= 10, `H=10 总高 (${lines.length}) 必须 <= 10`);

	h.comp.handleInput("m");
	lines = h.comp.render(80);
	assert.ok(lines.join("\n").includes("全量详情面板") || lines.join("\n").includes("tiny line"), "H=10 详情出口必须可用");
	assert.ok(lines.length <= 10, `H=10 面板态总高 (${lines.length}) 必须 <= 10`);
});

// ============================================================
// 4. 按键语义诚实（浏览态防误触 + 提示与行为一致）
// ============================================================

test("按键语义诚实: 详情面板浏览态 Esc 不触发拒绝，代码折叠态 Esc 才拒绝", async () => {
	const h = await setupDialogHarness({ terminalRows: 24, input: { command: "echo guard" } });

	// 进入详情面板（浏览态）
	h.comp.handleInput("m");
	assert.ok(h.comp.render(80).join("\n").includes("全量详情面板"), "面板打开");

	// 浏览态 Esc：退出面板，绝不触发拒绝
	h.comp.handleInput("\x1b");
	assert.equal(h.getSubmittedAction(), null, "面板态 Esc 绝不能提交拒绝");
	assert.ok(!h.comp.render(80).join("\n").includes("全量详情面板"), "Esc 退出面板回代码视图");

	// 数字键在浏览态不直接提交（先开面板验证）
	h.comp.handleInput("m");
	h.comp.handleInput("5");
	assert.equal(h.getSubmittedAction(), null, "面板态数字键不得直接提交");

	// 回到代码折叠态后 Esc = 拒绝（语义不变）
	h.comp.handleInput("m");
	h.comp.handleInput("\x1b");
	assert.equal(h.getSubmittedAction(), "block", "代码折叠态 Esc 仍为拒绝");
});

// ============================================================
// 5. 验收缺口补钉（ask 规则路径与 fallback 降级触发链的直测）
// ============================================================

test("事实载荷恒展示: ask 规则命中弹窗（auto-edit）可见修改载荷", async () => {
	const h = await setupDialogHarness({
		terminalRows: 40,
		mode: "auto-edit",
		toolName: "edit",
		rules: { ask: ["Edit(demo.ts)"] },
		input: (cwd) => ({
			path: join(cwd, "demo.ts"),
			edits: [{ oldText: "const askRuleOld = 1;", newText: "const askRuleNew = 2;" }],
		}),
	});
	const text = h.comp.render(80).join("\n");
	assert.ok(text.includes("Ask Rule"), "必须命中 ask 规则弹窗（而非普通人工审批弹窗）");
	assert.ok(text.includes("命中规则"), "展示命中规则条目");
	assert.ok(text.includes("修改载荷"), "ask 规则弹窗必须包含修改载荷条目");
	assert.ok(text.includes("const askRuleOld = 1;"), "匹配文本必须可见");
	assert.ok(text.includes("const askRuleNew = 2;"), "替换文本必须可见");
});

test("fallback 降级触发链: 分类器抛错 + 短命令，降级标注不吞没命令事实", async () => {
	const h = await setupDialogHarness({
		terminalRows: 40,
		mode: "auto",
		classifierThrows: true,
		input: { command: "rm -rf /tmp/demo-target" },
	});
	const lines = h.comp.render(80);
	const text = lines.join("\n");
	assert.ok(text.includes("分类器无判决"), "降级标注必须可见（人审需知判决来源）");
	assert.ok(text.includes("准备执行命令:"), "命令条目标签必须可见");
	assert.ok(text.includes("rm -rf /tmp/demo-target"), "短命令内容必须在首屏可见（不被更长的降级文案挤出主体）");
	// 命令是主体：标签行之后紧跟命令正文
	const labelIdx = lines.findIndex((l: string) => l.includes("准备执行命令:"));
	assert.ok(labelIdx >= 0 && labelIdx < lines.length - 1, "命令标签后必须有正文行");
});

test("fallback 降级触发链: 矮终端 H=12 命令事实仍内联可见且总高不超 H", async () => {
	const h = await setupDialogHarness({
		terminalRows: 12,
		mode: "auto",
		classifierThrows: true,
		input: { command: "rm -rf /tmp/demo-target" },
	});
	const lines = h.comp.render(80);
	assert.ok(lines.length <= 12, `H=12 总高 (${lines.length}) 必须 <= 12`);
	assert.ok(lines.join("\n").includes("rm -rf /tmp/demo-target"), "矮终端下短命令仍以内联形态可见");
});
