import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, stripTerminalSequences, Key } from "@earendil-works/pi-tui";
import approvalModeExtension, {
	wrapDialogLine,
	consolidateBlankLines,
	truncateLongLogicLine,
	formatFoldableDetail,
	calculateHeightBudget,
	resolveBatchProgress,
	formatDialogTitleWithBatch,
} from "../extensions/approval-mode.ts";

const dummyTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

// ============================================================
// 1. 空白行合并 (consolidateBlankLines)
// ============================================================

test("空白行合并: 单个空行原样保留，连续空行合并并显示数量", () => {
	const input = ["line 1", "", "line 2", "   ", "\t", "  ", "line 3", "", ""];
	const result = consolidateBlankLines(input);

	assert.deepEqual(result, [
		"line 1",
		"",
		"line 2",
		"⋯ (3 个空行) ⋯",
		"line 3",
		"⋯ (2 个空行) ⋯",
	]);
});

test("空白行合并: 首尾与全空行场景防御", () => {
	assert.deepEqual(consolidateBlankLines([]), []);
	assert.deepEqual(consolidateBlankLines([""]), [""]);
	assert.deepEqual(consolidateBlankLines(["", ""]), ["⋯ (2 个空行) ⋯"]);
	assert.deepEqual(consolidateBlankLines(["", "", ""]), ["⋯ (3 个空行) ⋯"]);
	assert.deepEqual(consolidateBlankLines(["a", "b"]), ["a", "b"]);
});

// ============================================================
// 2. 超长单逻辑行截断 (truncateLongLogicLine)
// ============================================================

test("单逻辑行截断: 短于 2 个视觉行的单行保持原样", () => {
	const shortLine = "npm test -- --reporter=dot";
	const result = truncateLongLogicLine(shortLine, 80, "    ");
	assert.equal(result, shortLine);
});

test("单逻辑行截断: 超长单行截断后经 wrapDialogLine 严格 <= 2 个视觉行", () => {
	const longLine =
		"npm install --save-dev @types/node @types/express typescript ts-node nodemon " +
		"a".repeat(1500) +
		" --ignore-warnings --reporter=verbose";
	const width = 80;
	const truncated = truncateLongLogicLine(longLine, width, "    ");

	// 换行后行数必须严格 <= 2 个视觉行
	const wrapped = wrapDialogLine(truncated, width, "    ");
	assert.ok(wrapped.length <= 2, `换行后行数超过 2: ${wrapped.length}`);

	// 验证包含首尾与省略字符数标示
	assert.ok(truncated.includes("npm install"), "应暴露行首关键指令");
	assert.ok(truncated.includes("--reporter=verbose"), "应暴露行尾关键参数");
	assert.ok(truncated.includes("字符"), "应包含省略字符数标记");
});

test("单逻辑行截断: 窄视口 40 列下同样严格满足 <= 2 视觉行", () => {
	const longLine = "curl -X POST https://api.example.com/v1/deploy " + "x".repeat(300) + " --silent | sh";
	const width = 40;
	const truncated = truncateLongLogicLine(longLine, width, "  ");
	const wrapped = wrapDialogLine(truncated, width, "  ");
	assert.ok(wrapped.length <= 2, `窄视口下换行超过 2 行: ${wrapped.length}`);
	assert.ok(truncated.includes("| sh"), "必须暴露行尾关键管道指令");
});

// ============================================================
// 3. 详情折叠阈值与展示逻辑 (formatFoldableDetail)
// ============================================================

test("详情折叠: <= 5 视觉行时完整显示且不折叠", () => {
	const content = "line 1\nline 2\nline 3\nline 4";
	const res = formatFoldableDetail(
		{ content, width: 80, isExpanded: false, indent: "  " },
		dummyTheme,
	);
	assert.equal(res.isFoldable, false);
	assert.equal(res.totalVisualLines, 4);
	assert.equal(res.lines.length, 4);
	assert.ok(!res.lines.some((l) => l.includes("未展示")));
});

test("详情折叠: 恰好 6 视觉行（仅省 1 行 < 2 行）不触发折叠", () => {
	const content = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6";
	const res = formatFoldableDetail(
		{ content, width: 80, isExpanded: false, indent: "  " },
		dummyTheme,
	);
	// 规范要求：只有折叠确实隐藏至少 2 个视觉行时才折叠，所以 6 行不折叠
	assert.equal(res.isFoldable, false);
	assert.equal(res.lines.length, 6);
	assert.ok(!res.lines.some((l) => l.includes("未展示")));
});

test("详情折叠: >= 7 视觉行触发折叠，折叠态展示头 3 尾 2 与省略提示", () => {
	const content = Array.from({ length: 15 }, (_, i) => `echo "step ${i + 1}"`).join("\n");
	const res = formatFoldableDetail(
		{ content, width: 80, isExpanded: false, indent: "  " },
		dummyTheme,
	);
	assert.equal(res.isFoldable, true);
	assert.equal(res.totalVisualLines, 15);

	// 折叠态：头 3 + 中间提示 1 + 尾 2 = 6 行
	assert.equal(res.lines.length, 6);
	assert.ok(res.lines[0].includes("step 1"), "头 1 对应 step 1");
	assert.ok(res.lines[1].includes("step 2"), "头 2 对应 step 2");
	assert.ok(res.lines[2].includes("step 3"), "头 3 对应 step 3");
	assert.ok(res.lines[3].includes("还有 10 视觉行未展示"), "中间提示省略 10 视觉行 (15 - 5)");
	assert.ok(res.lines[3].includes("共 15 视觉行"), "中间提示包含总视觉行数");
	assert.ok(res.lines[3].includes("按 v 或 Ctrl+O 展开"), "中间提示包含展开快捷键");
	assert.ok(res.lines[4].includes("step 14"), "尾 1 对应 step 14");
	assert.ok(res.lines[5].includes("step 15"), "尾 2 对应 step 15");
});

test("详情折叠: 展开态展示全部视觉行并在末尾提示收起", () => {
	const content = Array.from({ length: 10 }, (_, i) => `step_${i + 1}`).join("\n");
	const res = formatFoldableDetail(
		{ content, width: 80, isExpanded: true, indent: "  " },
		dummyTheme,
	);
	assert.equal(res.isFoldable, true);
	// 全部 10 行 + 末尾提示 1 行 = 11 行
	assert.equal(res.lines.length, 11);
	assert.ok(res.lines[res.lines.length - 1].includes("已展开完整内容，按 v 或 Ctrl+O 折叠收起"));
});

test("详情折叠: 展开态超过终端预算上限时受限展示并提示", () => {
	const content = Array.from({ length: 20 }, (_, i) => `step_${i + 1}`).join("\n");
	const maxExpandedLines = 8;
	const res = formatFoldableDetail(
		{ content, width: 80, isExpanded: true, indent: "  ", maxExpandedLines },
		dummyTheme,
	);
	assert.equal(res.isFoldable, true);
	assert.ok(res.lines.length <= maxExpandedLines + 2);
	assert.ok(res.lines.some((l) => l.includes("受终端高度预算限制已展开至 8 行")));
});

test("详情折叠: 单个超长逻辑行在折叠态展示截断行与下方提示", () => {
	const longLine = "echo " + "z".repeat(1200);
	const res = formatFoldableDetail(
		{ content: longLine, width: 80, isExpanded: false, indent: "  " },
		dummyTheme,
	);
	assert.equal(res.isFoldable, true);
	assert.ok(res.lines.length <= 4, "单逻辑行截断为 2 行，加提示行应不超过 4 行");
	assert.ok(res.lines.some((l) => l.includes("未展示")));
});

// ============================================================
// 4. 高度预算计算 (calculateHeightBudget)
// ============================================================

test("高度预算: 矮终端 (<= 28 行) 触发降级保护", () => {
	const b24 = calculateHeightBudget(24, 12);
	assert.equal(b24.isDegraded, true);
	assert.equal(b24.minTranscriptRows, 6, "矮终端保底 transcript 为 6 行");
	assert.equal(b24.maxDialogHeight, 18, "弹窗最多占 18 行 (24 - 6)");
	assert.ok(b24.maxDetailsLines >= 5, "保底详情可用行数");

	const b28 = calculateHeightBudget(28, 12);
	assert.equal(b28.isDegraded, true);
	assert.equal(b28.minTranscriptRows, 6);
});

test("高度预算: 标准终端 (> 28 行) 保留 >= 55% 视口", () => {
	const b40 = calculateHeightBudget(40, 13);
	assert.equal(b40.isDegraded, false);
	assert.equal(b40.minTranscriptRows, 22, "40 * 0.55 = 22 行");
	assert.equal(b40.maxDialogHeight, 18, "40 - 22 = 18 行");

	const b60 = calculateHeightBudget(60, 13);
	assert.equal(b60.isDegraded, false);
	assert.equal(b60.minTranscriptRows, 33, "60 * 0.55 = 33 行");
	assert.equal(b60.maxDialogHeight, 27, "60 - 33 = 27 行");
});

// ============================================================
// 5. 批次进度指示 (resolveBatchProgress & formatDialogTitleWithBatch)
// ============================================================

test("批次进度: 从当前 sessionManager 可靠匹配 toolCallId 与进度", () => {
	const sessionManager = {
		getBranch: () => [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "executing commands" },
						{ type: "toolCall", id: "call_1", name: "bash" },
						{ type: "toolCall", id: "call_2", name: "edit" },
						{ type: "toolCall", id: "call_3", name: "bash" },
					],
				},
			},
		],
	};

	const p1 = resolveBatchProgress(sessionManager, "call_1");
	assert.deepEqual(p1, { batchIndex: 1, batchTotal: 3 });

	const p2 = resolveBatchProgress(sessionManager, "call_2");
	assert.deepEqual(p2, { batchIndex: 2, batchTotal: 3 });

	const p3 = resolveBatchProgress(sessionManager, "call_3");
	assert.deepEqual(p3, { batchIndex: 3, batchTotal: 3 });
});

test("批次进度: 单工具调用或未找到时优雅返回 undefined (不猜测)", () => {
	const sessionSingle = {
		getBranch: () => [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "single_call", name: "bash" }],
				},
			},
		],
	};
	// 批次为 1 时不显示进度标记
	assert.equal(resolveBatchProgress(sessionSingle, "single_call"), undefined);
	assert.equal(resolveBatchProgress(sessionSingle, "non_existent"), undefined);
	assert.equal(resolveBatchProgress(null, "any"), undefined);
	assert.equal(resolveBatchProgress({ getBranch: () => [] }, "any"), undefined);
});

test("批次标题组合: formatDialogTitleWithBatch 格式规范", () => {
	const batch = { batchIndex: 2, batchTotal: 3 };
	assert.equal(
		formatDialogTitleWithBatch("[Manual 审批] bash: npm test", batch),
		"[Manual 审批] (批次 2/3) bash: npm test",
	);
	assert.equal(
		formatDialogTitleWithBatch("[Auto 审批] edit: src/app.ts", batch),
		"[Auto 审批] (批次 2/3) edit: src/app.ts",
	);
	assert.equal(
		formatDialogTitleWithBatch("Tool Confirmation", batch),
		"(批次 2/3) Tool Confirmation",
	);
	assert.equal(
		formatDialogTitleWithBatch("[Manual 审批] bash: git status", undefined),
		"[Manual 审批] bash: git status",
	);
});

// ============================================================
// 6. 端到端 TUI 弹窗交互测试 (折叠/展开/快捷键/矮终端)
// ============================================================

async function setupInteractiveTuiDialog(options?: {
	terminalRows?: number;
	sessionBranch?: any[];
	hasScrollApi?: boolean;
}): Promise<{
	handlers: Record<string, any>;
	commands: Record<string, any>;
	ctx: any;
	getRendered: () => any;
	scrollCalls: string[];
}> {
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
		getFlag: () => undefined,
	};
	approvalModeExtension(pi as any);

	const ctxModel = { provider: "ctx", id: "main" };
	const registry = {
		models: [ctxModel],
		find: () => null,
		getAll: () => [ctxModel] as any[],
		hasConfiguredAuth: () => true,
		complete: async () => ({ content: [{ type: "text", text: '{"shouldBlock": false}' }] }),
	};

	let rendered: any;
	const scrollCalls: string[] = [];

	const ctx: any = {
		modelRegistry: registry,
		model: ctxModel,
		mode: "tui",
		hasUI: true,
		ui: {
			notify: () => {},
			select: async () => null,
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
			setStatus: () => {},
			...(options?.hasScrollApi
				? {
						scrollTranscript: (dir: string) => {
							scrollCalls.push(dir);
						},
				  }
				: {}),
			custom: async (factory: (tui: any, theme: any, kb: any, done: (r: any) => void) => any) => {
				const tui = {
					requestRender: () => {},
					terminal: {
						rows: options?.terminalRows ?? 40,
						columns: 80,
					},
				};
				const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
				rendered = factory(tui, theme, undefined, () => {});
				return "block";
			},
		},
		cwd: mkdtempSync(join(tmpdir(), "pi-issue-0046-cwd-")),
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => options?.sessionBranch ?? [] },
	};

	await handlers["session_start"]({ reason: "start" }, ctx);
	await commands["approval-mode"].handler("manual", ctx);
	return { handlers, commands, ctx, getRendered: () => rendered, scrollCalls };
}

test("E2E: 长命令在标准终端默认折叠态（头 3 尾 2），按 v 展开，再按 v 折叠", async () => {
	const h = await setupInteractiveTuiDialog({ terminalRows: 40 });
	const multilineCmd = Array.from({ length: 16 }, (_, i) => `echo "command line ${i + 1}"`).join("\n");

	await h.handlers["tool_call"]({ toolName: "bash", input: { command: multilineCmd } }, h.ctx);
	const comp = h.getRendered();
	assert.ok(comp, "必须捕获到审批弹窗组件");

	// 1. 默认折叠态渲染
	const linesFolded = comp.render(80);
	const textFolded = linesFolded.join("\n");
	assert.ok(textFolded.includes("还有 11 视觉行未展示"), "折叠态必须展示未展示视觉行数");
	assert.ok(textFolded.includes("command line 1"), "头 1 可见");
	assert.ok(textFolded.includes("command line 2"), "头 2 可见");
	assert.ok(textFolded.includes("command line 3"), "头 3 可见");
	assert.ok(textFolded.includes("command line 15"), "尾 1 可见");
	assert.ok(textFolded.includes("command line 16"), "尾 2 可见");
	assert.ok(textFolded.includes("[v / Ctrl+O] 展开/折叠"), "底栏必须提供折叠快捷键提示");

	// 2. 按单键 "v" 展开
	comp.handleInput("v");
	const linesExpanded = comp.render(80);
	const textExpanded = linesExpanded.join("\n");
	assert.ok(linesExpanded.length > linesFolded.length, "展开态总行数必须增加");
	assert.ok(textExpanded.includes("command line 8"), "中间行在展开态必须可见");
	assert.ok(textExpanded.includes("已展开完整内容，按 v 或 Ctrl+O 折叠收起"), "展开态底提示正确");

	// 3. 再次按 "v" 收起
	comp.handleInput("v");
	const linesRefolded = comp.render(80);
	assert.equal(linesRefolded.length, linesFolded.length, "再次按 v 必须恢复收起状态");
	assert.ok(linesRefolded.join("\n").includes("还有 11 视觉行未展示"));
});

test("E2E: 支持 Ctrl+O (\\x0f) 和大写 V 切换展开/折叠", async () => {
	const h = await setupInteractiveTuiDialog({ terminalRows: 40 });
	const multilineCmd = Array.from({ length: 12 }, (_, i) => `echo "line ${i + 1}"`).join("\n");

	await h.handlers["tool_call"]({ toolName: "bash", input: { command: multilineCmd } }, h.ctx);
	const comp = h.getRendered();

	// 按 Ctrl+O (\x0f)
	comp.handleInput("\x0f");
	let lines = comp.render(80);
	assert.ok(lines.join("\n").includes("已展开完整内容"), "Ctrl+O 应展开");

	// 按大写 V 收起
	comp.handleInput("V");
	lines = comp.render(80);
	assert.ok(lines.join("\n").includes("还有 7 视觉行未展示"), "大写 V 应折叠");
});

test("E2E: 矮终端 (24 行) 降级保护——紧凑展示、选项与底栏不裁切", async () => {
	const h = await setupInteractiveTuiDialog({ terminalRows: 24 });
	const multilineCmd = Array.from({ length: 20 }, (_, i) => `echo "step ${i + 1}"`).join("\n");

	await h.handlers["tool_call"]({ toolName: "bash", input: { command: multilineCmd } }, h.ctx);
	const comp = h.getRendered();
	const lines = comp.render(80);

	// 弹窗总高度必须受到预算控制
	assert.ok(lines.length <= 20, `矮终端下弹窗总高度 (${lines.length}) 不得超过预算 (<= 20)`);

	const text = lines.join("\n");
	// 审批选项 1-6 必须完整可见
	assert.ok(text.includes("允许本次执行"), "选项 1 可见");
	assert.ok(text.includes("始终允许此操作"), "选项 2 可见");
	assert.ok(text.includes("始终允许在本项目中"), "选项 3 可见");
	assert.ok(text.includes("始终允许对该用户"), "选项 4 可见");
	assert.ok(text.includes("拒绝执行"), "选项 5 可见");
	// 矮终端模式下省略 description 节省空间
	assert.ok(!text.includes("在当前会话生命周期内免除此类审批"), "矮终端降级应省略选项描述");
	// 底栏提示完整可见
	assert.ok(text.includes("[快捷提示] 1-"), "底栏快捷提示完整可见");
});

test("E2E: 多工具调用批次进度指示 (批次 2/3)", async () => {
	const toolCallId = "call_p2";
	const sessionBranch = [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_p1", name: "bash" },
					{ type: "toolCall", id: "call_p2", name: "bash" },
					{ type: "toolCall", id: "call_p3", name: "bash" },
				],
			},
		},
	];

	const h = await setupInteractiveTuiDialog({ terminalRows: 40, sessionBranch });
	await h.handlers["tool_call"](
		{ toolCallId, toolName: "bash", input: { command: "git status" } },
		h.ctx,
	);
	const comp = h.getRendered();
	const lines = comp.render(80);
	const text = lines.join("\n");

	assert.ok(text.includes("(批次 2/3)"), `标题栏必须包含批次进度指示: ${lines[1]}`);
});

test("E2E: 翻页穿透特性探测与键盘事件转发", async () => {
	// 场景 A: 存在 scrollTranscript API
	const hWithApi = await setupInteractiveTuiDialog({ terminalRows: 40, hasScrollApi: true });
	await hWithApi.handlers["tool_call"]({ toolName: "bash", input: { command: "ls" } }, hWithApi.ctx);
	const compWithApi = hWithApi.getRendered();

	// 底栏显示 [PgUp/PgDn]
	assert.ok(compWithApi.render(80).join("\n").includes("[PgUp/PgDn] 翻阅历史"));

	// 按 PageUp 与 PageDown
	compWithApi.handleInput("\x1b[5~"); // PageUp
	compWithApi.handleInput("\x1b[6~"); // PageDown
	assert.deepEqual(hWithApi.scrollCalls, ["page-up", "page-down"]);

	// 场景 B: 不存在 scrollTranscript API (特性探测缺失)
	const hNoApi = await setupInteractiveTuiDialog({ terminalRows: 40, hasScrollApi: false });
	await hNoApi.handlers["tool_call"]({ toolName: "bash", input: { command: "ls" } }, hNoApi.ctx);
	const compNoApi = hNoApi.getRendered();

	// 底栏不显示 [PgUp/PgDn]，且按键不假装滚动、不抛异常
	assert.ok(!compNoApi.render(80).join("\n").includes("[PgUp/PgDn]"));
	compNoApi.handleInput("\x1b[5~");
	compNoApi.handleInput("\x1b[6~");
});
