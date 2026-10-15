/**
 * 审批弹窗展开态视口预算治理与交互解耦测试套件
 *
 * 验证核心能力：
 * 1. 视口高度预算平滑单调分配律与 H_min=16 刚性守卫（无反单调断崖）
 * 2. 两遍无依赖槽位判定算法（N=81, offset=71, H=24 末行 100% 可达，杜绝虚假触底）
 * 3. 诊断元数据刚性优先级全序（🚨 致命死循环预警置顶，多条目折叠钻取）
 * 4. 展开态独立按键状态机（方向键仅滚动正文不惊扰选项、Tab 唯一切换焦点、数字键仅聚焦防误提交、Esc/q 逃生收起不误拒、顶底直跳、进度保留）
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import approvalModeExtension, {
	calculateHeightBudget,
	formatFoldableDetail,
	truncateVisualLine,
	getMetadataPriority,
} from "../extensions/approval-mode.ts";

const dummyTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

// ============================================================
// 1. 终端高度分级退化阶梯与严格单调性测试
// ============================================================

test("高度预算阶梯: H < 16 刚性锁定紧凑态", () => {
	for (const h of [8, 10, 12, 14, 15]) {
		const b = calculateHeightBudget(h);
		assert.equal(b.isLockedCompact, true, `H=${h} 必须锁定紧凑态`);
		assert.equal(b.expandedHeroCapacity, 0, `H=${h} 主体预算必须为 0`);
		assert.equal(b.tier, "locked");
	}
});

test("高度预算阶梯: 16 <= H <= 40 全区间主体预算单调非递减 (无断崖反缩)", () => {
	let prevHeroCapacity = -1;
	for (let h = 16; h <= 40; h++) {
		const b = calculateHeightBudget(h);
		assert.equal(b.isLockedCompact, false, `H=${h} 应当允许展开`);
		assert.ok(
			b.expandedHeroCapacity >= prevHeroCapacity,
			`H=${h} 的容量 (${b.expandedHeroCapacity}) 不得低于 H=${h - 1} 的容量 (${prevHeroCapacity})`,
		);

		// 验证极值点预算
		if (h === 24) {
			assert.equal(b.tier, "compact");
			assert.equal(b.expandedHeroCapacity, 14, "H=24 紧凑态主体容量为 14");
		} else if (h === 25) {
			assert.equal(b.expandedHeroCapacity, 15, "H=25 容量平滑过渡至 15");
		} else if (h === 26) {
			assert.equal(b.tier, "footer_expanded");
			assert.equal(b.expandedHeroCapacity, 15, "H=26 铬饰扩展至 10，主体容量维持 15 无反缩");
		} else if (h === 28) {
			assert.equal(b.tier, "meta_expanded");
			assert.equal(b.expandedHeroCapacity, 16, "H=28 铬饰扩展至 11，主体容量平滑为 16");
		} else if (h === 30) {
			assert.equal(b.tier, "standard");
			assert.equal(b.expandedHeroCapacity, 17, "H=30 标准全量态主体容量为 17");
		}

		prevHeroCapacity = b.expandedHeroCapacity;
	}
});

// ============================================================
// 2. 两遍槽位判定算法与末行全可达性验证
// ============================================================

test("两遍槽位判定: N=81, H=24, offset=71 临界点末行 100% 可达且如实触底", () => {
	const content = Array.from({ length: 81 }, (_, i) => `script_line_${i + 1}`).join("\n");
	const b24 = calculateHeightBudget(24);
	// H=24 时主体可用行数 14
	const maxExpandedLines = b24.expandedHeroCapacity;
	assert.equal(maxExpandedLines, 14);

	// 翻至 offset = 71
	const res = formatFoldableDetail(
		{ content, width: 80, isExpanded: true, maxExpandedLines, pageOffset: 71 },
		dummyTheme,
	);

	assert.equal(res.isFoldable, true);
	// 验证包含首行与末行切片
	assert.ok(res.lines.some((l) => l.includes("script_line_72")), "显示切片首行可见 (0-indexed 71)");
	assert.ok(res.lines.some((l) => l.includes("script_line_81")), "第 81 行 (0-indexed 80) 必须完整可见，不得被截断");
	// 验证底部指示行如实声明已触底
	assert.ok(res.lines.some((l) => l.includes("✔ [已到底部 (共 81 行)]")), "末页必须如实声明触底");
	// 验证总渲染行数严格不超过 maxExpandedLines
	assert.ok(res.lines.length <= maxExpandedLines, `渲染行数 (${res.lines.length}) 不得突破预算 (${maxExpandedLines})`);
});

test("两遍槽位判定: 未触底页指示行清晰标注绝对行范围与剩余行数", () => {
	const content = Array.from({ length: 81 }, (_, i) => `line_${i + 1}`).join("\n");
	const maxExpandedLines = 14;

	// 首页 (offset = 0)
	const page0 = formatFoldableDetail(
		{ content, width: 80, isExpanded: true, maxExpandedLines, pageOffset: 0 },
		dummyTheme,
	);
	assert.ok(page0.lines.some((l) => l.includes("▼ [行 1–13 / 共 81 行] (余 68 行)")));

	// 中间页 (offset = 20)
	const pageMid = formatFoldableDetail(
		{ content, width: 80, isExpanded: true, maxExpandedLines, pageOffset: 20 },
		dummyTheme,
	);
	assert.ok(pageMid.lines.some((l) => l.includes("▲ 已上翻 (上方余 20 行)")));
	assert.ok(pageMid.lines.some((l) => l.includes("▼ [行 21–32 / 共 81 行] (余 49 行)")));
});

// ============================================================
// 3. 诊断元数据优先级全序与列宽物理裁剪
// ============================================================

test("诊断元数据优先级: 🚨 致命死循环预警严格置顶，事实载荷优先于 AI 转述", () => {
	assert.equal(getMetadataPriority("🚨 死循环预警"), 0);
	assert.equal(getMetadataPriority("致命安全告警"), 0);
	assert.equal(getMetadataPriority("⛔ 拦截原因"), 1);
	assert.equal(getMetadataPriority("⚠️ 降级说明"), 2);
	// 事实载荷类（命令全文/调用参数/修改载荷）必须排在 AI 转述之前
	assert.equal(getMetadataPriority("准备执行命令"), 3);
	assert.equal(getMetadataPriority("调用参数"), 3);
	assert.equal(getMetadataPriority("修改载荷"), 3);
	assert.equal(getMetadataPriority("操作摘要"), 4);
	assert.equal(getMetadataPriority("静态结构特征"), 5);
	assert.equal(getMetadataPriority("🔧 排障建议"), 6);

	// 排序验证
	const items = [
		{ label: "操作摘要", content: "..." },
		{ label: "🔧 排障建议", content: "..." },
		{ label: "🚨 死循环预警", content: "..." },
		{ label: "⛔ 拦截原因", content: "..." },
	];
	items.sort((a, b) => getMetadataPriority(a.label) - getMetadataPriority(b.label));
	assert.equal(items[0].label, "🚨 死循环预警", "死循环预警必须排序第一");
	assert.equal(items[1].label, "⛔ 拦截原因", "拦截原因必须排序第二");
	assert.equal(items[2].label, "操作摘要", "操作摘要必须排序第三");
	assert.equal(items[3].label, "🔧 排障建议", "排障建议必须排序第四");
});

test("单行物理列宽截断: truncateVisualLine 严格守护物理显示列宽", () => {
	const cjkLine = "这是一个非常非常长包含很多中文字符的全角提示文本行，用于检测物理宽度截断防软折行。";
	const truncated = truncateVisualLine(cjkLine, 30);
	assert.ok(visibleWidth(truncated) <= 30, `截断后显示宽度 (${visibleWidth(truncated)}) 必须 <= 30`);
	assert.ok(truncated.endsWith("…"), "超出截断应补省略号");

	// 不超限文本保持原样
	const short = "hello";
	assert.equal(truncateVisualLine(short, 10), "hello");
});

// ============================================================
// 4. 展开态交互解耦与防误触状态机端到端测试
// ============================================================

interface SetupDialogOptions {
	terminalRows?: number;
	command?: string;
	mode?: "manual" | "auto";
	classifierResult?: any;
}

async function setupTuiApprovalDialog(options: SetupDialogOptions = {}) {
	const terminalRows = options.terminalRows ?? 24;
	let renderedComponent: any = null;
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};

	let submittedAction: any = null;
	let doneCallback: ((action: any) => void) | null = null;

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
		getFlag: () => undefined,
	};
	approvalModeExtension(pi as any);

	const ctxModel = { provider: "ctx", id: "main" };
	const registry = {
		models: [ctxModel],
		find: () => null,
		getAll: () => [ctxModel] as any[],
		hasConfiguredAuth: () => true,
		complete: async () => ({
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
				doneCallback = (action: any) => {
					submittedAction = action;
					resolveCustom(action);
				};
				renderedComponent = factory(tui, theme, {}, doneCallback);
				return customFinished;
			},
			notify: () => {},
			select: async () => null,
		},
		cwd: mkdtempSync(join(tmpdir(), "pi-overflow-test-")),
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	await handlers["session_start"]({ reason: "start" }, mockExtensionContext);
	const targetMode = options.mode ?? "manual";
	if (commands["approval-mode"]) {
		await commands["approval-mode"].handler(targetMode, mockExtensionContext);
	}

	const longScript = options.command ?? Array.from({ length: 60 }, (_, i) => `echo "script step ${i + 1}"`).join("\n");

	// 非阻塞触发 tool_call 以便与挂载好的 TUI 组件交互
	const promise = handlers["tool_call"](
		{ toolName: "bash", input: { command: longScript } },
		mockExtensionContext,
	);

	// 等待组件挂载完毕
	while (!renderedComponent) {
		await new Promise((r) => setImmediate(r));
	}

	return {
		comp: renderedComponent,
		promise,
		getSubmittedAction: () => submittedAction,
	};
}

test("展开态按键状态机: 方向键仅微调滚动，绝对不改变选项焦点", async () => {
	const { comp } = await setupTuiApprovalDialog({ terminalRows: 24 });
	assert.ok(comp, "组件必须挂载");

	// 初始折叠态：光标默认在第 1 项 (Allow once)
	let text = comp.render(80).join("\n");
	assert.ok(text.includes("→ 1. 允许本次执行"), "初始光标在选项 1");

	// 按 "v" 进入展开态
	comp.handleInput("v");
	text = comp.render(80).join("\n");
	assert.ok(text.includes("[展开态]"), "应当进入展开态");
	assert.ok(text.includes("script step 1"), "展开态首屏可见 step 1");

	// 在展开态按 "↓" 或 "j"：向下平滑微调滚动 2 行
	comp.handleInput("j");
	text = comp.render(80).join("\n");
	// 验证：文本已向下微调，出现上方指示行
	assert.ok(text.includes("▲ 已上翻 (上方余 2 行)"), "应当向下滚动 2 行");
	// 核心不变量：底部的选项光标绝对不动，依然保持在选项 1！
	assert.ok(text.includes("→ 1. 允许本次执行"), "长文本滚动期间，选项光标必须原封不动留在选项 1，杜绝跳动");

	// 再次按 "↓"
	comp.handleInput("j");
	text = comp.render(80).join("\n");
	assert.ok(text.includes("▲ 已上翻 (上方余 4 行)"), "再次微调滚动至 4 行");
	assert.ok(text.includes("→ 1. 允许本次执行"), "选项光标依然在选项 1");
});

test("展开态按键状态机: Tab 键作为唯一移动选项焦点的途径", async () => {
	const { comp } = await setupTuiApprovalDialog({ terminalRows: 24 });
	comp.handleInput("v"); // 进入展开态

	// 按 Tab 切换选项焦点
	comp.handleInput("\t");
	let text = comp.render(80).join("\n");
	assert.ok(text.includes("→ 2. 始终允许此操作"), "Tab 键使光标下移至选项 2");

	// 再次按 Tab
	comp.handleInput("\t");
	text = comp.render(80).join("\n");
	assert.ok(text.includes("→ 3. 始终允许在本项目中"), "再次 Tab 光标下移至选项 3");

	// 按 Shift+Tab 逆向切回
	comp.handleInput("\x1b[Z");
	text = comp.render(80).join("\n");
	assert.ok(text.includes("→ 2. 始终允许此操作"), "Shift+Tab 光标回退至选项 2");
});

test("展开态按键安全: 数字键 1-5 仅聚焦选项，绝不自动提交 (防误触持久化放行)", async () => {
	const { comp, getSubmittedAction } = await setupTuiApprovalDialog({ terminalRows: 24 });

	comp.handleInput("v"); // 展开

	// 在展开态按数字键 2（Always allow for session/project）
	comp.handleInput("2");

	// 核心安全断言：绝不自动提交！
	assert.equal(getSubmittedAction(), null, "展开态按数字键 2 绝对不得自动提交");

	const text = comp.render(80).join("\n");
	assert.ok(text.includes("→ 2. "), "选项 2 被聚焦高亮");
	assert.ok(text.includes("[已聚焦选项 2"), "界面明确提示已聚焦并等待 Enter 确认");

	// 只有显式按 Enter 才能提交
	comp.handleInput("\r");
	assert.equal(getSubmittedAction(), "allow_session", "按 Enter 后确认执行选项 2");
});

test("秒级逃生舱: 展开态按 Esc 或 q 统一收起到折叠态，绝不直接 Reject", async () => {
	const { comp, getSubmittedAction } = await setupTuiApprovalDialog({ terminalRows: 24 });

	// 1. 展开
	comp.handleInput("v");
	assert.ok(comp.render(80).join("\n").includes("[展开态]"));

	// 2. 在展开态按 "q"
	comp.handleInput("q");
	// 核心断言：未被 Reject，而是收起到折叠态
	assert.equal(getSubmittedAction(), null, "展开态按 q 绝不得触发 Reject");
	assert.ok(!comp.render(80).join("\n").includes("[展开态]"), "按 q 后应收起回折叠态");

	// 3. 再次展开，按 "Esc"
	comp.handleInput("v");
	assert.ok(comp.render(80).join("\n").includes("[展开态]"));
	comp.handleInput("\x1b"); // Esc
	assert.equal(getSubmittedAction(), null, "展开态按 Esc 绝不得触发 Reject");
	assert.ok(!comp.render(80).join("\n").includes("[展开态]"), "按 Esc 后应收起回折叠态");

	// 4. 处于折叠态时按 Esc，才执行安全拒绝
	comp.handleInput("\x1b");
	assert.equal(getSubmittedAction(), "block", "折叠态按 Esc 必须执行安全拒绝");
});

test("直跳顶底: Home/End 与 g/G 直跳终点切片且末行可见", async () => {
	const { comp } = await setupTuiApprovalDialog({ terminalRows: 24 });
	comp.handleInput("v"); // 展开

	// 按大写 "G" 直跳末尾
	comp.handleInput("G");
	let text = comp.render(80).join("\n");
	assert.ok(text.includes("✔ [已到底部 (共 60 行)]"), "直跳底部应呈现触底提示");
	assert.ok(text.includes("script step 60"), "末行 60 必须清晰可见");

	// 按小写 "g" 直跳顶部
	comp.handleInput("g");
	text = comp.render(80).join("\n");
	assert.ok(text.includes("script step 1"), "直跳顶部首行必须清晰可见");
	assert.ok(!text.includes("▲ 已上翻"), "顶部无向上翻页提示");
});

test("进度记忆: v 键收起后再展开，保留上次浏览的滚动位置", async () => {
	const { comp } = await setupTuiApprovalDialog({ terminalRows: 24 });
	comp.handleInput("v"); // 展开

	// 滚两屏
	comp.handleInput(" "); // Space 下翻
	let text = comp.render(80).join("\n");
	assert.ok(text.includes("▲ 已上翻 (上方余"), "已有向下偏移");

	// 按 v 临时收起看上下文
	comp.handleInput("v");
	assert.ok(!comp.render(80).join("\n").includes("[展开态]"), "已收起");

	// 再次按 v 展开
	comp.handleInput("v");
	text = comp.render(80).join("\n");
	assert.ok(text.includes("▲ 已上翻 (上方余"), "再次展开后进度得到保留，无需重新翻阅");
});

test("全量诊断面板: m 键切换诊断视图与代码视图", async () => {
	const command = Array.from({ length: 20 }, (_, i) => `echo ${i + 1}`).join("\n");
	const { comp } = await setupTuiApprovalDialog({
		terminalRows: 24,
		mode: "auto",
		command,
		classifierResult: {
			shouldBlock: true,
			reason: "触碰高危系统目录 /etc",
			summary: "高危写操作尝试",
			diagnosticHint: "检查模型余额与网关配置",
		},
	});
	comp.handleInput("v"); // 展开

	let text = comp.render(80).join("\n");
	// 默认代码视图：高优先级原因置顶展示，代码正文作为主体
	assert.ok(text.includes("⛔ 拦截原因: 触碰高危系统目录 /etc"), "代码视图展示拦截原因");
	assert.ok(text.includes("echo 1"), "首屏展示代码正文");

	// 按 m 切换至全量诊断视图
	comp.handleInput("m");
	text = comp.render(80).join("\n");
	assert.ok(text.includes("全量详情面板"), "进入全量诊断视图");
	assert.ok(text.includes("高危写操作尝试"), "操作摘要在全量视图中可见");
	assert.ok(text.includes("触碰高危系统目录 /etc"), "拦截原因在全量视图中可见");

	// 再次按 m 切回代码视图
	comp.handleInput("m");
	text = comp.render(80).join("\n");
	assert.ok(text.includes("echo 1"), "切回代码正文主视图");
});
