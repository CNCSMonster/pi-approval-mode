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
import approvalModeExtension, { buildClassifierFallbackItem } from "../extensions/approval-mode.ts";
import { DENIAL_MESSAGES } from "../extensions/denial-tracker.ts";
import { analyzeShellCommand } from "../extensions/shell-analyzer.ts";
import { getMetadataPriority } from "../extensions/dialog-folding.ts";

interface SetupOptions {
	terminalRows?: number;
	mode?: "manual" | "auto" | "auto-edit";
	toolName?: string;
	input?: Record<string, any> | ((cwd: string) => Record<string, any>);
	classifierResult?: any;
	/** 分类器鉴权不可用（s2Model 缺位）→ 真启发式兜底路径 */
	hasConfiguredAuth?: boolean;
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
		hasConfiguredAuth: () => options.hasConfiguredAuth !== false,
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
// 1. outage 路径：保守拦截措辞，不得谎称启发式研判
// ============================================================

test("outage 弹窗如实标为保守拦截，不得声称已按启发式规则研判", async () => {
	const h = await setupDialogHarness({
		terminalRows: 40,
		mode: "auto",
		classifierThrows: true,
		input: { command: "cd /tmp/demo" },
	});
	let text = h.comp.render(80).join("\n");
	assert.ok(text.includes("分类器无判决"), "降级标注不得被挤出首屏 meta 预览");
	h.comp.handleInput("m");
	text = h.comp.render(80).join("\n");
	// 断言归一化：面板按列宽硬折行，词组可能被断行切开
	const flat = text.replace(/\s+/g, "");
	assert.ok(flat.includes("保守拦截"), "outage 路径必须标为保守拦截");
	assert.ok(flat.includes("未做规则研判"), "必须明示未做规则研判");
	assert.doesNotMatch(flat, /已按启发式规则研判/, "outage 路径不得谎称启发式研判");
	assert.doesNotMatch(flat, /降级为规则研判/, "outage 路径标签不得误导为规则研判");
});

test("分类器不可用时的真启发式兜底才允许声明启发式研判", async () => {
	const h = await setupDialogHarness({
		terminalRows: 40,
		mode: "auto",
		hasConfiguredAuth: false,
		input: { command: "rm -rf /tmp/demo-target" },
	});
	const text = h.comp.render(80).join("\n");
	assert.ok(text.includes("已按启发式规则研判"), "真启发式兜底执行过研判，如实声明");
	assert.ok(text.includes("启发式规则引擎命中") || text.includes("降级处置矩阵"), "拦截原因来自启发式规则引擎");
});

// ============================================================
// 2. 单元：文案与判词契约
// ============================================================

test("singleUnavailable 拒绝文案不谎称启发式回退", () => {
	const msg = DENIAL_MESSAGES.singleUnavailable("stage2_timeout(10000ms)");
	assert.doesNotMatch(msg, /Falling back to heuristic checks/, "outage 拒绝文案不得声称启发式回退");
	assert.match(msg, /NOT rule-evaluated/, "必须明示未做规则研判");
});

test("shell 内建命令判词中性化，不伪装白名单裁决", () => {
	const res = analyzeShellCommand("cd /tmp/demo");
	assert.doesNotMatch(res.reason ?? "", /未在只读白名单中/, "内建命令不得出现白名单裁决式判词");
	assert.match(res.reason ?? "", /不适用只读白名单判定/, "内建命令判词须中性");
	const unknown = analyzeShellCommand("totally-unknown-binary-xyz --help");
	assert.match(unknown.reason ?? "", /未在只读白名单中/, "非内建未知命令判词维持原语义");
});

test("降级标注条目单元契约：outage 与启发式两条措辞分离", () => {
	const outageItem = buildClassifierFallbackItem({ stage: "fallback", outage: true });
	assert.match(outageItem.label, /保守拦截/);
	assert.match(outageItem.content, /未做规则研判/);
	assert.doesNotMatch(outageItem.content, /已按启发式规则研判/);
	const heuristicItem = buildClassifierFallbackItem({ stage: "fallback" });
	assert.match(heuristicItem.label, /降级为规则研判/);
	assert.match(heuristicItem.content, /已按启发式规则研判/);
});

test("降级标注措辞变体同属 P2 降级说明级（防措辞演进挤出首屏）", () => {
	assert.equal(getMetadataPriority("⚠️ 分类器无判决（保守拦截）"), 2);
	assert.equal(getMetadataPriority("⚠️ 分类器无判决（降级为规则研判）"), 2);
});
