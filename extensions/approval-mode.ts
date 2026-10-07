/**
 * Approval Mode Extension for Pi
 *
 * 为 Pi 提供对齐千问 Code (Qwen Code) 的多级工具审批模式、权限规则体系与两阶段 LLM 安全分类器：
 *
 * 1. default   - 标准确认模式：文件修改 (edit/write) 与 Shell 命令 (bash) 执行前均需用户审批确认。
 * 2. auto-edit - 自动批准文件编辑：edit/write 自动放行，仅 Shell 命令 (bash) 需审批确认。
 * 3. auto      - 智能两阶段分类器模式（Qwen Code Auto 模式架构）：
 *                - Layer 1: 工作区常规文件修改免审（自身配置与敏感凭据除外）
 *                - Layer 2: 工业级 Shell 只读状态机——仅 plan 模式作守卫与 auto 弹窗"静态结构特征"展示；auto 下不再据此免审
 *                - Layer 3: 【双阶段 LLM 安全分类器 (Two-Stage Classifier)】
 *                  • Stage 1 (Fast Path): ~300ms 快速研判 (带 1500ms 超时熔断)
 *                  • Stage 2 (Review Path): 仅当 Stage 1 标记可疑时触发深度推理，消除误报
 *                  • 降级容灾：若分类器离线/超时/不可用，自动平滑回退至高危规则启发式风控
 * 4. yolo      - 全自动模式：除显式 deny 规则与死循环熔断外无条件执行所有工具。
 * 5. plan      - 只读规划模式：禁用 edit/write 工具，bash 仅放行只读白名单命令，动态注入只读规划提示词。
 *
 * 规则体系与优先状态机 (Qwen Code 对齐)：
 * - Deny (3, 最高) > Ask (2) > Default (1) > Allow (0)
 * - 支持 DSL 规则语法：ToolName(specifier)，如 Bash(git status), Read(/src/**), Edit(.env*)
 * - 宏元分类支持：Read, Edit, Bash
 * - 跨层级 Union 并集管理：Session、Project (.pi/approval-rules.json)、User (~/.pi/agent/approval-rules.json)
 *
 * 审批弹窗特性：
 * - 数字快捷键直选：直接按下数字键 1 - 5 即可瞬间完成审批确认，无需回车！
 * - 视口自适应换行：长命令/长内容按终端宽度换行完整展示，不再截断省略
 * - 四级免审作用域 (单次 / 会话 / 项目级持久化 / 用户级持久化 / 拒绝)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, type AutocompleteItem } from "@earendil-works/pi-tui";

import { classifyStage1, findClassifierModel } from "./stage1-classifier.ts";
import { analyzeShellCommand } from "./shell-analyzer.ts";
import {
	fallbackHeuristicCheck,
	evaluateFallbackAction,
	isProtectedPath,
	isEscapingWorkspace,
	CLASSIFIER_BASE_PROMPT,
	type FallbackAction,
} from "./heuristic-guard.ts";
import {
	PermissionManager,
	buildReadDslRule,
	formatScopeName,
	getToolDefaultPermission,
	isReadOnlyTool,
	resolveReadDisposition,
} from "./permission-engine.ts";
import { LoopDetector, type LoopCheckResult } from "./loop-detector.ts";
import {
	DenialTracker,
	DENIAL_MESSAGES,
	formatDenyReasonForAgent,
	formatLoopReasonForAgent,
	formatUserRejectionReasonForAgent,
	formatUserAbortReasonForAgent,
} from "./denial-tracker.ts";
import {
	projectToolInput,
	buildTranscript,
	StageHealthTracker,
	STAGE1_ESCALATE_THRESHOLD,
	type Stage1FailureReason,
	type Stage1HealthStatus,
} from "./classifier-projection.ts";
import {
	ALL_MODES,
	normalizeMode,
	loadApprovalConfig,
	type ApprovalMode,
	type ApprovalConfigFile,
} from "./approval-config.ts";
import { sanitizeUntrustedDetail, type SanitizedDetailResult } from "./detail-sanitizer.ts";
import {
	wrapDialogLine,
	consolidateBlankLines,
	truncateLongLogicLine,
	formatFoldableDetail,
	calculateHeightBudget,
	resolveBatchProgress,
	formatDialogTitleWithBatch,
	type BatchProgress,
	type HeightBudget,
	type FoldedDetailResult,
} from "./dialog-folding.ts";

// 对外 API 再导出（历史习惯从 approval-mode 取这些符号）
export {
	ALL_MODES,
	normalizeMode,
	loadApprovalConfig,
	sanitizeUntrustedDetail,
	StageHealthTracker,
	STAGE1_ESCALATE_THRESHOLD,
	evaluateFallbackAction,
	formatDenyReasonForAgent,
	formatLoopReasonForAgent,
	formatUserRejectionReasonForAgent,
	formatUserAbortReasonForAgent,
	wrapDialogLine,
	consolidateBlankLines,
	truncateLongLogicLine,
	formatFoldableDetail,
	calculateHeightBudget,
	resolveBatchProgress,
	formatDialogTitleWithBatch,
};
export type {
	ApprovalMode,
	ApprovalConfigFile,
	SanitizedDetailResult,
	Stage1FailureReason,
	Stage1HealthStatus,
	FallbackAction,
	BatchProgress,
	HeightBudget,
	FoldedDetailResult,
};

// 模式说明文案
const MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
	manual: "🛡️ manual - 人审模式（文件修改与 Shell 命令均需人工审批）",
	"auto-edit": "📝 auto-edit - 自动批准文件编辑（仅 Shell 命令需审批）",
	auto: "⚖️ auto - 智能分类器模式（双阶段 LLM 自动判定意图与风险）",
	yolo: "⚡ yolo - 全自动模式（除显式 deny 规则与死循环熔断外直接执行）",
	plan: "📋 plan - 只读分析模式（禁用编辑/写入工具，仅放行只读命令）",
};

// 审批动作类型
export type ApprovalAction =
	| "allow_once" // 1. 允许本次执行
	| "allow_session" // 2. 始终允许此项 (仅当前会话)
	| "allow_project" // 3. 始终允许在本项目中 (项目级持久化)
	| "allow_user" // 4. 始终允许对该用户 (全局用户级持久化)
	| "block" // 5. 拒绝执行 (Esc / Block)
	| "block_and_abort"; // 6. 拒绝并指示停止 (Block & Abort)

interface ApprovalOption {
	key: string;
	action: ApprovalAction;
	label: string;
	description: string;
}

const APPROVAL_OPTIONS: ApprovalOption[] = [
	{
		key: "1",
		action: "allow_once",
		label: "允许本次执行 (Allow once)",
		description: "仅放行本次操作，下次仍会提示确认",
	},
	{
		key: "2",
		action: "allow_session",
		label: "始终允许此操作 (当前会话免审)",
		description: "当前会话内重复该操作不再询问，会话关闭后重置",
	},
	{
		key: "3",
		action: "allow_project",
		label: "始终允许在本项目中 (项目级持久化)",
		description: "保存至当前工作区配置 (.pi/approval-rules.json)，以后在本目录均免审",
	},
	{
		key: "4",
		action: "allow_user",
		label: "始终允许对该用户 (全局用户级持久化)",
		description: "保存至全局用户配置 (~/.pi/agent/approval-rules.json)，任何项目均免审",
	},
	{
		key: "5",
		action: "block",
		label: "拒绝执行 (Block)",
		description: "阻止执行该工具并向模型反馈 (快捷键: Esc)",
	},
];

const LOOP_ABORT_OPTION: ApprovalOption = {
	key: "6",
	action: "block_and_abort",
	label: "拒绝并指示停止 (Block & Abort)",
	description: "拒绝执行并命令模型停止当前死循环尝试，必须更换解决思路",
};

function formatDialogTitle(baseTitle: string, subType: string, loopCheck: LoopCheckResult): string {
	if (!loopCheck.isLoop) {
		return baseTitle;
	}
	const streak = loopCheck.streak;
	if (streak <= 3) {
		return `🚨 [死循环高危预警 (第 ${streak} 次): ${subType}]`;
	}
	return `🔥 [死循环严重预警 (已连续 ${streak} 次 · 持续停滞): ${subType}]`;
}

// ==========================================
// 配置文件格式与加载：见 ./approval-config.ts（纯模块，零 pi 依赖，可单测）
// ==========================================

/**
 * 将配置持久化保存到全局文件
 */
function saveGlobalApprovalConfig(patch: Partial<ApprovalConfigFile>): void {
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const globalConfigPath = join(dir, "approval-config.json");
		let current: ApprovalConfigFile = {};
		if (existsSync(globalConfigPath)) {
			try {
				current = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
			} catch {
				// ignore
			}
		}
		const updated = { ...current, ...patch };
		writeFileSync(globalConfigPath, JSON.stringify(updated, null, 2), "utf-8");
	} catch (err) {
		console.error("[approval-mode] 保存配置文件失败:", err);
	}
}

// ==========================================
// Qwen Code 对齐：安全分类器策略与提示词 (由单一来源 heuristic-guard 导出)
// ==========================================

const STAGE1_SUFFIX = `
Respond with JSON only: { "shouldBlock": boolean }. No markdown, no reasoning, no other fields. Err on the side of blocking — stage 2 will review uncertain blocks.`;

const STAGE2_SUFFIX = `
Stage 1 flagged this as potentially unsafe. Review carefully — false positives hurt user experience. Use thinking to reason about whether the user's explicit instructions justify this action. If safe, set shouldBlock=false. If unsafe, set shouldBlock=true and provide one short sentence in reason.
Respond with JSON only: { "shouldBlock": boolean, "reason": string }.`;



export function parseClassifierJson(text: string): any {
	try {
		const trimmed = text.trim();
		const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			return JSON.parse(jsonMatch[0]);
		}
	} catch {
		// ignore
	}
	return null;
}

/**
 * Promise 超时封装，防止网络阻塞导致整个 Pi 挂起
 */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeoutValue: T): Promise<T> {
	let timer: NodeJS.Timeout;
	const timeoutPromise = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(onTimeoutValue), ms);
	});
	return Promise.race([promise, timeoutPromise]).finally(() => {
		clearTimeout(timer);
	});
}

export function resolveClassifierModel(
	ctx: ExtensionContext,
	stageSpecificModel?: string,
	sharedModel?: string,
	notifyFallback = false,
	stageName = "分类器",
	allowClassifier = true,
): { model: any; label: string; fallbackReason?: string; configValue?: string; stageName: string } {
	const candidates = [
		{ pattern: stageSpecificModel, reason: `${stageName}独立配置` },
		{ pattern: sharedModel, reason: "共享配置 (classifierModel)" },
	];

	let fallbackReason: string | undefined;
	let configValue = stageSpecificModel || sharedModel;

	for (const { pattern, reason } of candidates) {
		if (!pattern) continue;
		let found: any = null;
		if (pattern.includes("/")) {
			const [p, ...rest] = pattern.split("/");
			const id = rest.join("/");
			const candidate = ctx.modelRegistry.find(p, id);
			if (candidate && ctx.modelRegistry.hasConfiguredAuth(candidate)) {
				found = candidate;
			}
		} else {
			for (const m of ctx.modelRegistry.getAll()) {
				if (m.id === pattern && ctx.modelRegistry.hasConfiguredAuth(m)) {
					found = m;
					break;
				}
			}
		}
		// chat 目录未命中时回退原生 classifier 目录
		//（chat find()/getAll() 按设计过滤非 chat 模型，专职决策模型必须走 findOfType）。
		// Stage 2 传 allowClassifier=false：绝不对 classifier 调 complete()（拍板 #5）。
		if (!found && allowClassifier) {
			found = findClassifierModel(ctx.modelRegistry, pattern);
		}
		if (found) {
			return { model: found, label: `${found.provider}/${found.id}`, fallbackReason, configValue, stageName };
		}
		if (notifyFallback && ctx.hasUI) {
			ctx.ui.notify(
				`[ApprovalMode] ${reason} "${pattern}" 未找到或未配置有效认证，已回退。`,
				"warning",
			);
		}
		if (!fallbackReason) fallbackReason = `配置值 ${pattern} 无效`;
	}

	// 默认优先查找 gemini-3.8-flash-high-lp
	const preferred =
		ctx.modelRegistry.find("llm-proxy-openai-chat", "gemini-3.8-flash-high-lp") ||
		ctx.modelRegistry.find("llm-proxy-openai-responses", "gemini-3.8-flash-high-lp") ||
		ctx.modelRegistry.find("llm-proxy-anthropic", "gemini-3.8-flash-high-lp");

	if (preferred && ctx.modelRegistry.hasConfiguredAuth(preferred)) {
		if (!fallbackReason && configValue) fallbackReason = "回退到内置默认";
		return { model: preferred, label: `${preferred.provider}/${preferred.id}`, fallbackReason, configValue, stageName };
	}

	for (const m of ctx.modelRegistry.getAll()) {
		if (m.id === "gemini-3.8-flash-high-lp" && ctx.modelRegistry.hasConfiguredAuth(m)) {
			if (!fallbackReason && configValue) fallbackReason = "回退到内置默认";
			return { model: m, label: `${m.provider}/${m.id}`, fallbackReason, configValue, stageName };
		}
	}

	// 安全策略：如果未配置专门分类器且当前模型为主模型，在非轻量场景避免无节制开销
	if (!fallbackReason && configValue) fallbackReason = "回退到主模型";
	return { model: ctx.model, label: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "无", fallbackReason, configValue, stageName };
}

// ==========================================
// 分类器 Stage 1 / Stage 2 超时配置校验（载入时执行，纯逻辑、可单测）
//
// 单一规则：任一字段违规 → 警告 + 两字段整体回退默认 1500/3000。
// stage2 缺省走派生（有效 stage1 × 2），非违规。
// ==========================================

const CLASSIFIER_TIMEOUT_DEFAULT_STAGE1 = 1500;
const CLASSIFIER_TIMEOUT_DEFAULT_STAGE2 = 3000;
const CLASSIFIER_TIMEOUT_MIN = 500;
const CLASSIFIER_TIMEOUT_MAX_STAGE1 = 60000;
const CLASSIFIER_TIMEOUT_MAX_STAGE2 = 600000;

function formatReceivedTimeout(v: unknown): string {
	if (typeof v === "number") {
		if (Number.isNaN(v)) return "NaN";
		if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
		return String(v);
	}
	return JSON.stringify(v) ?? String(v);
}

function timeoutFieldValid(v: unknown, max: number): boolean {
	if (typeof v !== "number") return false; // 堵字符串 "5000"
	if (!Number.isFinite(v) || !Number.isInteger(v)) return false; // 堵 NaN/Infinity/小数
	if (v < CLASSIFIER_TIMEOUT_MIN) return false;
	if (v > max) return false;
	return true;
}

export interface ClassifierTimeoutResolution {
	stage1: number;
	stage2: number;
	violated: boolean;
}

/**
 * 校验并解析分类器超时配置，返回 stage1/stage2 有效值。
 * 违规时发出 console.warn 一行（含字段名、收到值、回退结果）并在提供 ctx 时 ctx.ui.notify 一次；
 * 载入完成后 console.debug 打一行两字段 effective 值。
 */
export function applyClassifierTimeoutConfig(
	fileConfig: ApprovalConfigFile,
	ctx?: { ui?: { notify?: (message: string, level: string) => void } },
): ClassifierTimeoutResolution {
	const s1Provided = typeof fileConfig.classifierTimeoutMs !== "undefined";
	const s2Provided = typeof fileConfig.classifierStage2TimeoutMs !== "undefined";

	let stage1 = CLASSIFIER_TIMEOUT_DEFAULT_STAGE1;
	let stage2 = CLASSIFIER_TIMEOUT_DEFAULT_STAGE2;
	let violation: string | undefined;

	if (s1Provided) {
		const candS1 = fileConfig.classifierTimeoutMs;
		if (!timeoutFieldValid(candS1, CLASSIFIER_TIMEOUT_MAX_STAGE1)) {
			violation = `classifierTimeoutMs 收到 ${formatReceivedTimeout(candS1)}（须为 ${CLASSIFIER_TIMEOUT_MIN}–${CLASSIFIER_TIMEOUT_MAX_STAGE1} 的整数毫秒）`;
		} else {
			stage1 = candS1 as number;
		}
	}

	if (!violation) {
		if (s2Provided) {
			const candS2 = fileConfig.classifierStage2TimeoutMs;
			if (!timeoutFieldValid(candS2, CLASSIFIER_TIMEOUT_MAX_STAGE2)) {
				violation = `classifierStage2TimeoutMs 收到 ${formatReceivedTimeout(candS2)}（须为 ${CLASSIFIER_TIMEOUT_MIN}–${CLASSIFIER_TIMEOUT_MAX_STAGE2} 的整数毫秒）`;
			} else if ((candS2 as number) <= stage1) {
				violation = `classifierStage2TimeoutMs 收到 ${formatReceivedTimeout(candS2)}，必须大于 classifierTimeoutMs (${stage1})`;
			} else {
				stage2 = candS2 as number;
			}
		} else {
			stage2 = stage1 * 2;
		}
	}

	if (violation) {
		stage1 = CLASSIFIER_TIMEOUT_DEFAULT_STAGE1;
		stage2 = CLASSIFIER_TIMEOUT_DEFAULT_STAGE2;
		const message =
			`[ApprovalMode] 分类器超时配置违规：${violation}；stage1/stage2 整体回退默认 ${CLASSIFIER_TIMEOUT_DEFAULT_STAGE1}/${CLASSIFIER_TIMEOUT_DEFAULT_STAGE2}ms。`;
		console.warn(message);
		ctx?.ui?.notify?.(message, "warning");
	}

	console.debug(`[ApprovalMode] 分类器超时 effective: stage1=${stage1}ms stage2=${stage2}ms`);
	return { stage1, stage2, violated: Boolean(violation) };
}

// ==========================================
// /classifier-model 参数解析、帮助与自动补全纯逻辑
// ==========================================

export const CLASSIFIER_SET_FLAGS = ["--stage1", "--stage2", "--both"] as const;
export type ClassifierSetFlag = (typeof CLASSIFIER_SET_FLAGS)[number];

export type ClassifierModelCommand =
	| { kind: "status" }
	| { kind: "help" }
	| { kind: "clear"; targets: ClassifierSetFlag[] }
	| { kind: "set"; pairs: { flag: ClassifierSetFlag; model: string }[] }
	| { kind: "error"; message: string };

export const CLASSIFIER_USAGE =
	"用法: /classifier-model [--stage1 <m>] [--stage2 <m>] [--both <m>] | clear [--stage1|--stage2|--both] | help";

export const CLASSIFIER_FLAG_DESCRIPTIONS: Record<string, string> = {
	"--stage1": "设置 Stage 1（快筛）专属模型",
	"--stage2": "设置 Stage 2（复核）专属模型",
	"--both": "一个模型同时用于 Stage 1 与 Stage 2",
	clear: "清空分类器模型配置；可用 --stage1/--stage2/--both 指定范围",
	help: "显示用法与示例",
};

export const CLASSIFIER_CLEAR_TARGET_DESCRIPTIONS: Record<ClassifierSetFlag, string> = {
	"--stage1": "清除 Stage 1 专属模型配置",
	"--stage2": "清除 Stage 2 专属模型配置",
	"--both": "清除共享与两阶段配置（≡ clear）",
};

// ==========================================
// 配置冲突治理纯函数
// ==========================================

/**
 * 判定配置中是否处于三方共存冲突拓扑。
 * 当 classifierModel、classifierStage1Model 与 classifierStage2Model 三者同时存在时判定冲突。
 */
export function detectClassifierConflict(config: {
	classifierModel?: string;
	classifierStage1Model?: string;
	classifierStage2Model?: string;
}): boolean {
	return Boolean(config.classifierModel && config.classifierStage1Model && config.classifierStage2Model);
}

/** 构建三方共存冲突就地忽略告警文案 */
export function buildClassifierConflictWarning(baseModel: string): string {
	return `⚠️ [ApprovalMode] 检测到分类器模型配置冲突：classifierModel、classifierStage1Model 与 classifierStage2Model 同时存在。处理策略：按 Stage 1 与 Stage 2 专属模型执行，全局 classifierModel ("${baseModel}") 已被就地忽略（未修改磁盘文件）。`;
}

/** 构建公共底座被错误配置为专职分类器的告警文案 */
export function buildBaseClassifierWarning(baseModel: string): string {
	return `⚠️ [ApprovalMode] 公共底座 classifierModel ("${baseModel}") 为专职分类器 (State Classifier)。公共底座必须为通用 LLM；该模型绝不能作为 Stage 2 的继承底座。`;
}

/** 构建 Stage 2 专属被错误配置为专职分类器的告警文案 */
export function buildStage2ClassifierWarning(stage2Model: string): string {
	return `⚠️ [ApprovalMode] Stage 2 专属模型 ("${stage2Model}") 为专职分类器 (State Classifier)。Stage 2 复核需通用 LLM 生成人类可读理由，该配置无效。`;
}

/**
 * 校验模型是否为专职分类器（State Classifier，type === "classifier"）。
 * 支持 provider/id 格式与裸 id 查找。
 */
export function isClassifierTypeModel(registry: ModelRegistryLike, pattern?: string): boolean {
	if (!registry || !pattern) return false;

	// 先走 classifier 目录精确查找
	const clf = findClassifierModel(registry, pattern);
	if (clf && clf.type === "classifier") return true;

	// 再走 chat 目录查找（以防万一某些模型同时出现在两个目录）
	if (pattern.includes("/")) {
		const slashIdx = pattern.indexOf("/");
		const provider = pattern.slice(0, slashIdx);
		const id = pattern.slice(slashIdx + 1);
		if (typeof registry.find === "function") {
			try {
				const m = registry.find(provider, id);
				if (m && m.type === "classifier") return true;
			} catch {
				// ignore
			}
		}
	} else if (typeof registry.getAll === "function") {
		try {
			for (const m of registry.getAll()) {
				if (m && (m.id === pattern || `${m.provider}/${m.id}` === pattern) && m.type === "classifier") {
					return true;
				}
			}
		} catch {
			// ignore
		}
	}
	return false;
}

export const CLASSIFIER_HELP_TEXT = `/classifier-model — 查看或设置 Auto 模式分类器模型

用法:
  /classifier-model                                   查看两阶段状态与用法提示
  /classifier-model --stage1 <model>                  设置 Stage 1（快筛）专属模型
  /classifier-model --stage2 <model>                  设置 Stage 2（复核）专属模型
  /classifier-model --stage1 <m1> --stage2 <m2>       两阶段分别设置（顺序无关）
  /classifier-model --both <model>                    一个模型同时用于两阶段
  /classifier-model clear                             清空全部分类器模型配置（回落内置默认→主模型）
  /classifier-model clear --stage1 [--stage2]         按目标清除（--both ≡ clear）
  /classifier-model help                              显示本帮助

示例:
  /classifier-model --stage1 deepseek/deepseek-flash --stage2 deepseek/deepseek-v4-pro
  /classifier-model --both deepseek/deepseek-flash
  /classifier-model clear --stage1

说明: --both 与 --stage1/--stage2 互斥；旧语法 <model>/default 已移除（分别用 --both <model>/clear）`;

export function formatModelCost(input?: number, output?: number): string {
	const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(4))));
	const inStr = typeof input === "number" ? fmtNum(input) : "0";
	const outStr = typeof output === "number" ? fmtNum(output) : "0";
	return `$${inStr}/$${outStr} per M`;
}

export function formatModelCtx(ctxWindow?: number): string {
	if (!ctxWindow || ctxWindow <= 0) return "";
	if (ctxWindow >= 1_000_000) {
		const val = +(ctxWindow / 1_000_000).toFixed(1);
		return `${val}M ctx`;
	}
	return `${Math.round(ctxWindow / 1_000)}K ctx`;
}

export function buildModelDescription(
	m: { cost?: { input?: number; output?: number }; reasoning?: boolean; contextWindow?: number },
	isCurrentEffective = false,
): string | undefined {
	const parts: string[] = [];

	// 1. cost（无 cost 或均为 0 时整段省略）
	const cost = m.cost;
	if (cost && ((cost.input && cost.input > 0) || (cost.output && cost.output > 0))) {
		parts.push(formatModelCost(cost.input, cost.output));
	}

	// 2. reasoning 标记（非 reasoning 省略）
	if (m.reasoning) {
		parts.push("reasoning");
	}

	// 3. 上下文窗口
	const ctxStr = formatModelCtx(m.contextWindow);
	if (ctxStr) {
		parts.push(ctxStr);
	}

	if (parts.length === 0) {
		return isCurrentEffective ? "✓ 当前生效" : undefined;
	}

	const meta = parts.join(" · ");
	return isCurrentEffective ? `✓ ${meta}` : meta;
}

export function parseClassifierModelArgs(args: string): ClassifierModelCommand {
	const text = (args ?? "").trim();
	if (text === "") return { kind: "status" };

	const tokens = text.split(/\s+/).filter(Boolean);
	const first = tokens[0];

	// help 必须单独出现（C8）
	if (first === "help") {
		if (tokens.length > 1) {
			return { kind: "error", message: `"help" 必须单独使用，不能与其他参数同现` };
		}
		return { kind: "help" };
	}

	// clear 子命令（首 token）
	if (first === "clear") {
		const targets: ClassifierSetFlag[] = [];
		for (const t of tokens.slice(1)) {
			if (!t.startsWith("--")) {
				return { kind: "error", message: `clear 后面仅接受目标 flag（--stage1/--stage2/--both），不支持位置入参 "${t}"` };
			}
			const lower = t.toLowerCase();
			if (CLASSIFIER_SET_FLAGS.includes(lower as ClassifierSetFlag) && t !== lower) {
				return { kind: "error", message: `flag 严格小写，不接受 "${t}"（可用：--stage1 / --stage2 / --both）` };
			}
			if (!CLASSIFIER_SET_FLAGS.includes(t as ClassifierSetFlag)) {
				return { kind: "error", message: `未知 flag "${t}"（flag 严格小写，可用：--stage1 / --stage2 / --both）` };
			}
			const flag = t as ClassifierSetFlag;
			if (targets.includes(flag)) {
				return { kind: "error", message: `重复 flag "${t}"（同一条命令只能出现一次）` };
			}
			if (flag === "--both" && targets.length > 0) {
				return { kind: "error", message: `"--both" 与目标 flag 互斥，不能在 clear 中同现` };
			}
			if (flag !== "--both" && targets.includes("--both")) {
				return { kind: "error", message: `"--both" 与目标 flag 互斥，不能在 clear 中同现` };
			}
			targets.push(flag);
		}
		return { kind: "clear", targets };
	}

	// 设置 flags 序列
	const pairs: { flag: ClassifierSetFlag; model: string }[] = [];
	const seen: ClassifierSetFlag[] = [];
	let i = 0;

	while (i < tokens.length) {
		const tok = tokens[i];

		if (tok === "clear") {
			return { kind: "error", message: `"clear" 只能作为首 token 子命令，不能与设置 flag 混用` };
		}
		if (tok === "help") {
			return { kind: "error", message: `"help" 必须单独使用，不能与设置 flag 混用` };
		}
		if (!tok.startsWith("--")) {
			return { kind: "error", message: `不支持位置入参 "${tok}"（旧语法已移除：设置用 --both <m>，重置用 clear）` };
		}

		const lower = tok.toLowerCase();
		if (CLASSIFIER_SET_FLAGS.includes(lower as ClassifierSetFlag) && tok !== lower) {
			return { kind: "error", message: `flag 严格小写，不接受 "${tok}"（可用：--stage1 / --stage2 / --both）` };
		}
		if (!CLASSIFIER_SET_FLAGS.includes(tok as ClassifierSetFlag)) {
			return { kind: "error", message: `未知 flag "${tok}"（flag 严格小写，可用：--stage1 / --stage2 / --both）` };
		}

		const flag = tok as ClassifierSetFlag;
		if (seen.includes(flag)) {
			return { kind: "error", message: `重复 flag "${flag}"（同一条命令只能出现一次）` };
		}
		if (flag === "--both" && seen.length > 0) {
			return { kind: "error", message: `"--both" 与 --stage1/--stage2 互斥，不能出现在同一条命令` };
		}
		if (flag !== "--both" && seen.includes("--both")) {
			return { kind: "error", message: `"--both" 与 --stage1/--stage2 互斥，不能出现在同一条命令` };
		}

		const val = tokens[i + 1];
		if (val === undefined) {
			return { kind: "error", message: `"${flag}" 缺少模型值` };
		}
		if (val.startsWith("--")) {
			return { kind: "error", message: `"${flag}" 的值不能以 "--" 开头（"${val}"）——是否缺少模型值？` };
		}
		if (val === "clear") {
			return { kind: "error", message: `"clear" 不能作为 flag 的值` };
		}
		if (val === "help") {
			return { kind: "error", message: `"help" 不能作为 flag 的值（help 必须单独出现）` };
		}

		pairs.push({ flag, model: val });
		seen.push(flag);
		i += 2;
	}

	return { kind: "set", pairs };
}

export default function approvalModeExtension(pi: ExtensionAPI): void {
	let currentMode: ApprovalMode = "auto";
	let currentToolCallId: string | undefined;
	let toolsBeforePlanMode: string[] | undefined;
	let customClassifierModel: string | undefined;
	let customClassifierStage1Model: string | undefined;
	let customClassifierStage2Model: string | undefined;

	/**
	 * 获取生效的公共底座模型。
	 * 三方共存时就地忽略底座（切断穿透备胎），返回 undefined。
	 * Stage 2 场景下若底座为专职分类器也返回 undefined（Strict Capability Boundary）。
	 */
	function getEffectiveSharedModel(stageName: "Stage 1" | "Stage 2", ctx?: ExtensionContext): string | undefined {
		if (customClassifierModel && customClassifierStage1Model && customClassifierStage2Model) {
			// 三方共存非法拓扑：就地忽略底座，切断穿透备胎
			return undefined;
		}
		if (stageName === "Stage 2") {
			const reg = ctx?.modelRegistry ?? latestCtx?.modelRegistry;
			if (reg && isClassifierTypeModel(reg, customClassifierModel)) {
				// 底座为专职分类器：Strict Capability Boundary，严禁作为 Stage 2 继承底座
				return undefined;
			}
		}
		return customClassifierModel;
	}

	let classifierTimeoutMs = 1500;
	let classifierStage2TimeoutMs = 3000;
	let latestCtx: ExtensionContext | undefined;

	// Qwen Code 四态权限规则管理器
	let permissionManager: PermissionManager;

	// 死循环与连续失败统计熔断器
	const loopDetector = new LoopDetector();

	// 无头拦截状态机与动作指纹短路追踪器 (Qwen Code 对齐)
	const denialTracker = new DenialTracker();
	const stageHealthTracker = new StageHealthTracker();
	const notifiedFallbacks = new Set<string>();

	// 1. 注册 CLI 命令行启动参数
	pi.registerFlag("approval-mode", {
		description: "设置工具审批模式: default, auto-edit, auto, yolo, plan",
		type: "string",
	});

	pi.registerFlag("yolo", {
		description: "全自动执行所有工具（相当于 --approval-mode yolo）",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("classifier-model", {
		description: "Auto 模式下审批分类器使用的快速模型 (默认: llm-proxy-openai-chat/gemini-3.8-flash-high-lp)",
		type: "string",
	});

	// 更新 TUI 底部状态栏指示器 (: 状态栏支持 Stage 1 degraded 常驻轻量感知)
	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx?.ui?.setStatus) return;
		const theme = ctx.ui.theme;
		let autoBadge = theme.fg("borderAccent", "⚖️ auto");
		if (currentMode === "auto") {
			const s1Health = stageHealthTracker.getStatus();
			if (s1Health.status === "degraded") {
				autoBadge = theme.fg("warning", "⚖️ auto | S1⚠️");
			}
		}

		const badges: Record<ApprovalMode, string> = {
			manual: theme.fg("success", "🛡️ manual"),
			"auto-edit": theme.fg("accent", "📝 auto-edit"),
			auto: autoBadge,
			yolo: theme.fg("error", "⚡ yolo"),
			plan: theme.fg("warning", "📋 plan"),
		};

		ctx.ui.setStatus("approval-mode", `[${badges[currentMode]}]`);
	}

	// 动态调整工具可用性（plan 模式禁用写入工具）
	function applyModeTools(targetMode: ApprovalMode): void {
		if (targetMode === "plan") {
			if (toolsBeforePlanMode === undefined) {
				toolsBeforePlanMode = pi.getActiveTools();
			}
			const readOnlyTools = toolsBeforePlanMode.filter((t) => t !== "edit" && t !== "write");
			pi.setActiveTools(readOnlyTools);
		} else {
			if (toolsBeforePlanMode !== undefined) {
				pi.setActiveTools(toolsBeforePlanMode);
				toolsBeforePlanMode = undefined;
			}
		}
	}

	// 切换审批模式
	function switchMode(newMode: ApprovalMode, ctx: ExtensionContext, silent = false): void {
		if (newMode === currentMode) return;

		const prevMode = currentMode;
		currentMode = newMode;

		loopDetector.reset();
		//  /  Timing 4：与 loopDetector 对称重置 denialTracker，跨模式不带旧债
		// （plan 连拒切 auto 开局即清零，含 totalBlock/totalUnavailable/指纹/自愈连击）。
		denialTracker.resetAll();
		stageHealthTracker.reset();
		applyModeTools(newMode);

		// auto 护栏：进入 auto 暂存危险 allow 规则，离开 auto 恢复
		if (newMode === "auto") {
			const stripped = permissionManager?.stripDangerousAllowRulesForAuto() ?? [];
			if (stripped.length > 0 && !silent) {
				ctx.ui.notify(
					`⚠️ auto 模式已暂存 ${stripped.length} 条过宽 allow 规则（如 ${stripped[0]}），期间由分类器统一研判；退出 auto 自动恢复。`,
					"warning",
				);
			}
		} else if (prevMode === "auto") {
			permissionManager?.restoreDangerousAllowRules();
		}

		updateStatus(ctx);

		if (!silent) {
			ctx.ui.notify(`审批模式已切换为: ${newMode}`, "info");
		}

		try {
			pi.appendEntry("approval-mode-state", { mode: currentMode });
		} catch {
			// 忽略非核心错误
		}
	}

	// 循环切换到下一个审批模式（供全局快捷键与审批弹窗共用）
	function cycleApprovalMode(ctx: ExtensionContext, silent = false): void {
		const currentIndex = ALL_MODES.indexOf(currentMode);
		const nextMode = ALL_MODES[(currentIndex + 1) % ALL_MODES.length];
		switchMode(nextMode, ctx, silent);
	}

	// 2. 会话启动初始化与恢复 (包含生命周期安全降级与优先级裁决)
	pi.on("session_start", async (event, ctx) => {
		latestCtx = ctx;
		const isReload = event.reason === "reload";
		const isTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;

		if (isReload && permissionManager) {
			permissionManager.setIsTrusted(isTrusted);
		} else {
			permissionManager = new PermissionManager(ctx.cwd, undefined, undefined, isTrusted);
		}

		// reload 时热更新模型注册表（使新写入的 ~/.pi/agent/models.json 立即生效）
		if (isReload && ctx.modelRegistry && typeof ctx.modelRegistry.refresh === "function") {
			try {
				await ctx.modelRegistry.refresh({ allowNetwork: false });
			} catch {
				// 忽略模型刷新异常
			}
		}

		// 读取配置文件（过信任闸）
		const { config: fileConfig, projectConfigBlocked } = loadApprovalConfig(ctx.cwd, isTrusted, getAgentDir());
		const projectRulesBlocked = permissionManager.isProjectRulesBlocked();

		// 若当前项目未受信任且携带项目级配置或规则，发出明确安全告警
		if (!isTrusted && (projectConfigBlocked || projectRulesBlocked)) {
			ctx.ui.notify(
				`⚠️ 检测到当前工作区未受信任（Untrusted）。为防御恶意安全策略劫持，项目级审批配置与规则已被安全闸阻断禁用，仅加载用户全局配置。如需启用请使用 --approve 信任项目。`,
				"warning",
			);
		}
		customClassifierModel = fileConfig.classifierModel;
		customClassifierStage1Model = fileConfig.classifierStage1Model;
		customClassifierStage2Model = fileConfig.classifierStage2Model;

		// 分类器配置冲突治理与能力契约对齐
		if (detectClassifierConflict(fileConfig)) {
			const conflictMsg = buildClassifierConflictWarning(fileConfig.classifierModel!);
			console.warn(conflictMsg);
			if (ctx.hasUI) {
				ctx.ui.notify(conflictMsg, "warning");
			}
		}
		if (fileConfig.classifierModel && isClassifierTypeModel(ctx.modelRegistry, fileConfig.classifierModel)) {
			const baseClassifierMsg = buildBaseClassifierWarning(fileConfig.classifierModel);
			console.warn(baseClassifierMsg);
			if (ctx.hasUI) {
				ctx.ui.notify(baseClassifierMsg, "warning");
			}
		}
		if (fileConfig.classifierStage2Model && isClassifierTypeModel(ctx.modelRegistry, fileConfig.classifierStage2Model)) {
			const s2ClassifierMsg = buildStage2ClassifierWarning(fileConfig.classifierStage2Model);
			console.warn(s2ClassifierMsg);
			if (ctx.hasUI) {
				ctx.ui.notify(s2ClassifierMsg, "warning");
			}
		}

		const timeoutConfig = applyClassifierTimeoutConfig(fileConfig, ctx);
		classifierTimeoutMs = timeoutConfig.stage1;
		classifierStage2TimeoutMs = timeoutConfig.stage2;
		loopDetector.resetThresholds(fileConfig.loopDetection);
		denialTracker.resetConfig({
			limits: fileConfig.denialLimits,
			abortOnDenialCap: fileConfig.headlessAbortOnDenialCap,
		});
		denialTracker.resetAll();
		loopDetector.reset();
		stageHealthTracker.reset();

		// 基线默认模式（内置回退 auto；旧配置值 default 经别名映射为 manual）
		const baselineMode: ApprovalMode = normalizeMode(fileConfig.defaultMode) ?? "auto";

		// 检查会话历史（针对 pi -c / pi -r 恢复旧会话场景）
		let historicalMode: ApprovalMode | undefined;
		try {
			const branch = ctx.sessionManager.getBranch();
			for (const entry of branch) {
				if (entry.type === "custom" && entry.customType === "approval-mode-state") {
					const data = entry.data as { mode?: ApprovalMode } | undefined;
					const normalizedHistory = normalizeMode(data?.mode);
					if (normalizedHistory) {
						historicalMode = normalizedHistory;
					}
				}
			}
		} catch {
			// 忽略未就绪异常
		}

		if (historicalMode) {
			if (historicalMode === "yolo") {
				// 【安全防呆降级】：历史为 YOLO 时，自动降级为安全基线模式，防止幽灵提权
				currentMode = baselineMode;
				ctx.ui.notify(
					`⚠️ 检测到该会话此前处于 YOLO 模式，出于安全考虑已自动重置为安全模式 [${baselineMode}]。`,
					"warning",
				);
			} else {
				currentMode = historicalMode;
			}
		} else {
			currentMode = baselineMode;
		}

		// 显式 CLI 参数具有绝对最高裁决权
		if (pi.getFlag("yolo")) {
			currentMode = "yolo";
		} else {
			const flagMode = normalizeMode(pi.getFlag("approval-mode"));
			if (flagMode) {
				currentMode = flagMode;
			}
		}

		const flagClassifier = pi.getFlag("classifier-model") as string | undefined;
		if (flagClassifier) {
			customClassifierModel = flagClassifier;
			customClassifierStage1Model = undefined;
			customClassifierStage2Model = undefined;
		}

		applyModeTools(currentMode);
		updateStatus(ctx);

		// auto 护栏：进入 auto 即暂存宽到足以绕过分类器的危险 allow 规则；否则恢复暂存
		if (currentMode === "auto") {
			const stripped = permissionManager.stripDangerousAllowRulesForAuto();
			if (stripped.length > 0) {
				ctx.ui.notify(
					`⚠️ auto 模式已暂存 ${stripped.length} 条过宽 allow 规则（如 ${stripped[0]}），期间由分类器统一研判；退出 auto 自动恢复。`,
					"warning",
				);
			}
		} else {
			permissionManager.restoreDangerousAllowRules();
		}

		// 若本次为 /reload 触发，且处于交互 UI 界面下，输出状态就绪摘要与模型解析告警
		if (isReload && ctx.hasUI) {
			const r1 = resolveClassifierModel(ctx, customClassifierStage1Model, getEffectiveSharedModel("Stage 1", ctx), true, "Stage 1");
			const r2 = resolveClassifierModel(ctx, customClassifierStage2Model, getEffectiveSharedModel("Stage 2", ctx), true, "Stage 2", false);
			const modelLabel = (r1.label === r2.label) ? r1.label : `S1:${r1.label} | S2:${r2.label}`;
			const sRules = permissionManager.getSessionRules();
			const pRules = permissionManager.getProjectRules();
			const uRules = permissionManager.getUserRules();
			const sCount =
				sRules.allow.length + sRules.ask.length + sRules.deny.length + sRules.default.length;
			const pCount =
				pRules.allow.length + pRules.ask.length + pRules.deny.length + pRules.default.length;
			const uCount =
				uRules.allow.length + uRules.ask.length + uRules.deny.length + uRules.default.length;

			const trustLabel = isTrusted ? "已信任" : "未信任(已隔离项目配置)";
			const pLabel = isTrusted ? `${pCount}` : "0(隔离)";

			ctx.ui.notify(
				`[ApprovalMode 重载就绪] 模式: ${currentMode} | 信任: ${trustLabel} | 分类器: ${modelLabel} | 规则: 会话 ${sCount} / 项目 ${pLabel} / 全局 ${uCount}`,
				"info",
			);
		}
	});

	// 3. 注册命令：/approval-mode
	const modeCommandHandler = async (args: string | undefined, ctx: ExtensionContext) => {
		const inputMode = normalizeMode(args?.trim().toLowerCase());
		if (inputMode) {
			switchMode(inputMode, ctx);
			return;
		}

		if (!ctx.hasUI) {
			ctx.ui.notify(`当前审批模式: ${currentMode}。可用模式: ${ALL_MODES.join(", ")}`, "info");
			return;
		}

		const menuItems = ALL_MODES.map((m) => {
			const prefix = m === currentMode ? "● " : "○ ";
			return `${prefix}${MODE_DESCRIPTIONS[m]}`;
		});

		const selected = await ctx.ui.select("选择工具执行审批模式 (Approval Mode):", menuItems);

		if (selected) {
			for (const m of ALL_MODES) {
				if (selected.includes(m)) {
					switchMode(m, ctx);
					break;
				}
			}
		}
	};

	// 审批模式参数补全提示（输入 /approval-mode 后按 Tab 显示可选模式）
	const MODE_SHORT_DESCRIPTIONS: Record<ApprovalMode, string> = {
		manual: "人审模式（文件修改与 Shell 命令均需人工审批）",
		"auto-edit": "自动批准文件编辑（仅 Shell 命令需审批）",
		auto: "智能分类器模式（双阶段 LLM 自动判定风险）",
		yolo: "全自动模式（除显式 deny 规则与死循环熔断外直接执行）",
		plan: "只读规划模式（禁用编辑/写入，仅放行只读命令）",
	};

	function getModeCompletions(prefix: string): AutocompleteItem[] | null {
		const p = prefix.trim().toLowerCase();
		const items = ALL_MODES
			.filter((m) => m.startsWith(p))
			.map((m) => ({
				value: m,
				label: m,
				description: MODE_SHORT_DESCRIPTIONS[m],
			}));
		return items.length > 0 ? items : null;
	}

	pi.registerCommand("approval-mode", {
		description: "查看或切换审批模式 (manual, auto-edit, auto, yolo, plan)",
		getArgumentCompletions: getModeCompletions,
		handler: modeCommandHandler,
	});

	// 管理与查看四态权限规则：/approval-rules
	pi.registerCommand("approval-rules", {
		description: "查看或清空权限规则 (/approval-rules [list|clear])",
		handler: async (args, ctx) => {
			if (!permissionManager) {
				permissionManager = new PermissionManager(ctx.cwd);
			}
			permissionManager.reloadAll();
			const sub = args?.trim().toLowerCase();

			if (sub === "clear") {
				const choice = await ctx.ui.select("选择要清空的权限规则范围:", [
					"1. 清空当前会话规则 (Session Rules)",
					"2. 清空当前项目规则 (.pi/approval-rules.json)",
					"3. 清空全局用户规则 (~/.pi/agent/approval-rules.json)",
					"4. 取消",
				]);
				if (choice?.startsWith("1")) {
					permissionManager.clearSessionRules();
					ctx.ui.notify("已清空当前会话规则", "info");
				} else if (choice?.startsWith("2")) {
					permissionManager.clearProjectRules();
					ctx.ui.notify("已清空项目级权限规则", "info");
				} else if (choice?.startsWith("3")) {
					permissionManager.clearUserRules();
					ctx.ui.notify("已清空全局用户级权限规则", "info");
				}
				return;
			}

			// 查看列表
			const session = permissionManager.getSessionRules();
			const project = permissionManager.getProjectRules();
			const user = permissionManager.getUserRules();

			const formatRules = (
				title: string,
				r: { allow: string[]; ask: string[]; deny: string[]; default: string[] },
				scope: "session" | "project" | "user",
			) => {
				const items: string[] = [];
				for (const rule of r.deny) {
					items.push(`  ⛔ deny: ${rule}`);
				}
				for (const rule of r.ask) {
					const conflict = permissionManager.checkConflict("ask", rule, scope);
					const status = conflict.shadowedBy ? ` [⚠️ 被${formatScopeName(conflict.shadowedBy.scope)} deny 压死]` : "";
					items.push(`  ⚠️ ask:  ${rule}${status}`);
				}
				for (const rule of r.default) {
					const conflict = permissionManager.checkConflict("default", rule, scope);
					const status = conflict.shadowedBy
						? ` [⚠️ 被${formatScopeName(conflict.shadowedBy.scope)} ${conflict.shadowedBy.verdict} 压死]`
						: "";
					items.push(`  🔁 default: ${rule}${status}`);
				}
				for (const rule of r.allow) {
					const conflict = permissionManager.checkConflict("allow", rule, scope);
					const status = conflict.shadowedBy
						? ` [⚠️ 被${formatScopeName(conflict.shadowedBy.scope)} ${conflict.shadowedBy.verdict} 压死]`
						: "";
					items.push(`  ✅ allow: ${rule}${status}`);
				}
				return [title, items.length > 0 ? items.join("\n") : "  (无)"].join("\n");
			};

			const stashed = permissionManager.getStashedAllowRules();
			const report = [
				`📋 [Qwen Code 风格工具权限规则概览]`,
				formatRules(`• 会话级规则 (Session)`, session, "session"),
				formatRules(`• 项目级规则 (Project: .pi/approval-rules.json)`, project, "project"),
				formatRules(`• 全局用户级规则 (Global: ~/.pi/agent/approval-rules.json)`, user, "user"),
				...(stashed.length > 0
					? [
							`• ⏸️ auto 暂存的危险 allow 规则（退出 auto 自动恢复）:\n${stashed
								.map((s) => `  ⏸️ allow[${s.scope}]: ${s.rule}`)
								.join("\n")}`,
					  ]
					: []),
			].join("\n\n");

			ctx.ui.notify(report, "info");
		},
	});

	function buildClassifierStatusReport(ctx: ExtensionContext): string {
		const isConflict = Boolean(customClassifierModel && customClassifierStage1Model && customClassifierStage2Model);
		const s1Shared = getEffectiveSharedModel("Stage 1", ctx);
		const s2Shared = getEffectiveSharedModel("Stage 2", ctx);
		const r1 = resolveClassifierModel(ctx, customClassifierStage1Model, s1Shared, false, "Stage 1");
		const r2 = resolveClassifierModel(ctx, customClassifierStage2Model, s2Shared, false, "Stage 2", false);

		const baseMsg = isConflict
			? `公共底座: 配置值 ${customClassifierModel} [⚠️ 冲突已忽略：两阶段均已单独指定，此项未启用]\n`
			: "";

		const s1Msg = `Stage 1: 配置值 ${r1.configValue || "未配置"} → 生效值 ${r1.label}` + (r1.fallbackReason ? ` (回退原因: ${r1.fallbackReason})` : "");
		const s2Msg = `Stage 2: 配置值 ${r2.configValue || "未配置"} → 生效值 ${r2.label}` + (r2.fallbackReason ? ` (回退原因: ${r2.fallbackReason})` : "");

		const s1Health = stageHealthTracker.getStatus();
		const s1HealthMsg = `Stage 1 运行健康: ${s1Health.status} (连续失败 ${s1Health.consecutiveFailures} 次，累计 ${s1Health.totalFailures} 次)`;

		return `当前审批分类器模型状态:\n${baseMsg}${s1Msg}\n${s2Msg}\n${s1HealthMsg}\n配置文件: ~/.pi/agent/approval-config.json\n\n${CLASSIFIER_USAGE}`;
	}

	function validateClassifierModelRef(ctx: ExtensionContext, modelRef: string, flag: ClassifierSetFlag): { ok: boolean; reason?: string } {
		// classifier（System One 决策）模型仅服务于 --stage1；Stage 2 需生成人类可读复核理由，恒为通用 LLM（拍板 #5）。
		const classifierForStage2 = {
			ok: false,
			reason: "该模型是 classifier（System One 专职分类器）模型，仅支持 --stage1；Stage 2 复核需通用 LLM 生成人类可读理由",
		};
		const accept = (m: any): { ok: boolean; reason?: string } =>
			m?.type === "classifier" && flag !== "--stage1" ? classifierForStage2 : { ok: true };

		if (modelRef.includes("/")) {
			const slashIdx = modelRef.indexOf("/");
			const provider = modelRef.slice(0, slashIdx);
			const id = modelRef.slice(slashIdx + 1);
			const found = ctx.modelRegistry.find(provider, id);
			if (found && ctx.modelRegistry.hasConfiguredAuth(found)) {
				return { ok: true };
			}
			// chat 目录未命中 → 原生 classifier 目录（findOfType/全量 ID 匹配）
			const clf = findClassifierModel(ctx.modelRegistry, modelRef);
			if (clf) return accept(clf);
			return { ok: false, reason: "未找到该模型或未配置有效认证" };
		}
		for (const m of ctx.modelRegistry.getAll()) {
			if (m.id === modelRef && ctx.modelRegistry.hasConfiguredAuth(m)) {
				return { ok: true };
			}
		}
		const clf = findClassifierModel(ctx.modelRegistry, modelRef);
		if (clf) return accept(clf);
		return { ok: false, reason: "未找到该模型或未配置有效认证" };
	}

	function getClassifierModelCompletions(argumentPrefix: string): AutocompleteItem[] | null {
		const raw = argumentPrefix ?? "";
		const trailingSpace = /\s$/.test(raw);
		const tokens = raw.trim().split(/\s+/).filter(Boolean);
		const completed = trailingSpace ? tokens : tokens.slice(0, -1);
		const partial = trailingSpace ? "" : (tokens.length > 0 ? tokens[tokens.length - 1] : "");

		// 1. START 槽位（未完成任何 token）
		if (completed.length === 0) {
			const startOptions = [...CLASSIFIER_SET_FLAGS, "clear", "help"] as const;
			const matched = startOptions.filter((opt) => opt.startsWith(partial));
			if (matched.length === 0) return null;
			return matched.map((opt) => ({
				value: opt,
				label: opt,
				description: CLASSIFIER_FLAG_DESCRIPTIONS[opt],
			}));
		}

		const head = completed[0];

		// 2. HELP 分支
		if (head === "help") {
			return null;
		}

		// 3. CLEAR 分支
		if (head === "clear") {
			const usedTargets: ClassifierSetFlag[] = [];
			for (const t of completed.slice(1)) {
				if (!CLASSIFIER_SET_FLAGS.includes(t as ClassifierSetFlag)) {
					return null;
				}
				const flag = t as ClassifierSetFlag;
				if (usedTargets.includes(flag)) return null;
				if (flag === "--both" && usedTargets.length > 0) return null;
				if (flag !== "--both" && usedTargets.includes("--both")) return null;
				usedTargets.push(flag);
			}

			let candidateFlags: ClassifierSetFlag[] = [];
			if (usedTargets.length === 0) {
				candidateFlags = [...CLASSIFIER_SET_FLAGS];
			} else if (usedTargets.includes("--both")) {
				return null;
			} else {
				candidateFlags = CLASSIFIER_SET_FLAGS.filter((f) => f !== "--both" && !usedTargets.includes(f));
			}

			const matched = candidateFlags.filter((f) => f.startsWith(partial));
			if (matched.length === 0) return null;
			const base = completed.join(" ");
			return matched.map((f) => ({
				value: `${base} ${f}`,
				label: f,
				description: CLASSIFIER_CLEAR_TARGET_DESCRIPTIONS[f],
			}));
		}

		// 4. 设置 flags 序列
		const usedFlags: ClassifierSetFlag[] = [];
		let i = 0;
		while (i < completed.length) {
			const flagTok = completed[i];
			if (!CLASSIFIER_SET_FLAGS.includes(flagTok as ClassifierSetFlag)) {
				return null;
			}
			const flag = flagTok as ClassifierSetFlag;
			if (usedFlags.includes(flag)) return null;
			if (flag === "--both" && usedFlags.length > 0) return null;
			if (flag !== "--both" && usedFlags.includes("--both")) return null;

			// 若当前 flag 处于最后一个 completed token，说明正在输入其模型值（SET_VALUE）
			if (i + 1 >= completed.length) {
				const models = latestCtx?.modelRegistry?.getAll() ?? [];
				const base = completed.join(" ");

				let currentEffectiveLabel: string | undefined;
				if (latestCtx) {
					if (flag === "--stage1") {
						currentEffectiveLabel = resolveClassifierModel(latestCtx, customClassifierStage1Model, getEffectiveSharedModel("Stage 1", latestCtx), false, "Stage 1").label;
					} else if (flag === "--stage2") {
						currentEffectiveLabel = resolveClassifierModel(latestCtx, customClassifierStage2Model, getEffectiveSharedModel("Stage 2", latestCtx), false, "Stage 2", false).label;
					} else {
						const r1 = resolveClassifierModel(latestCtx, customClassifierStage1Model, getEffectiveSharedModel("Stage 1", latestCtx), false, "Stage 1").label;
						const r2 = resolveClassifierModel(latestCtx, customClassifierStage2Model, getEffectiveSharedModel("Stage 2", latestCtx), false, "Stage 2", false).label;
						if (r1 === r2) currentEffectiveLabel = r1;
					}
				}

				const items: AutocompleteItem[] = [];
				for (const m of models) {
					const ref = `${m.provider}/${m.id}`;
					if (!ref.startsWith(partial)) continue;
					const isCurrent = ref === currentEffectiveLabel;
					const desc = buildModelDescription(m, isCurrent);
					items.push({
						value: `${base} ${ref}`,
						label: ref,
						...(desc ? { description: desc } : {}),
					});
				}

				// 动态枚举原生 classifier 模型目录（仅 --stage1；替代  的硬编码单条补全）
				if (flag === "--stage1") {
					let classifiers: any[] = [];
					try {
						classifiers = latestCtx?.modelRegistry?.getModelsOfType?.("classifier") ?? [];
					} catch {
						classifiers = [];
					}
					for (const m of classifiers) {
						const ref = `${m.provider}/${m.id}`;
						if (!ref.startsWith(partial)) continue;
						if (items.some((it) => it.label === ref)) continue;
						const isCurrent = ref === currentEffectiveLabel;
						const meta = buildModelDescription(m, false);
						const parts = ["System One 专职分类器"];
						if (meta) parts.push(meta);
						const desc = isCurrent ? `✓ 当前生效 · ${parts.join(" · ")}` : parts.join(" · ");
						items.push({ value: `${base} ${ref}`, label: ref, description: desc });
					}
				}
				return items.length > 0 ? items : null;
			}

			const val = completed[i + 1];
			if (val.startsWith("--") || val === "clear" || val === "help") {
				return null;
			}

			usedFlags.push(flag);
			i += 2;
		}

		// 5. 完整成对后，输入下一个 flag（SET_FLAG）
		if (i === completed.length) {
			let candidateFlags: ClassifierSetFlag[] = [];
			if (usedFlags.includes("--both")) {
				return null;
			} else {
				candidateFlags = CLASSIFIER_SET_FLAGS.filter((f) => f !== "--both" && !usedFlags.includes(f));
			}

			const matched = candidateFlags.filter((f) => f.startsWith(partial));
			if (matched.length === 0) return null;
			const base = completed.join(" ");
			return matched.map((f) => ({
				value: `${base} ${f}`,
				label: f,
				description: CLASSIFIER_FLAG_DESCRIPTIONS[f],
			}));
		}

		return null;
	}

	// 配置分类器模型：/classifier-model
	pi.registerCommand("classifier-model", {
		description: "查看/设置分类器模型（--stage1/--stage2/--both；clear/help）",
		getArgumentCompletions: (argumentPrefix) => getClassifierModelCompletions(argumentPrefix),
		handler: async (args, ctx) => {
			const parsed = parseClassifierModelArgs(args ?? "");

			if (parsed.kind === "error") {
				ctx.ui.notify(`${parsed.message}\n\n${CLASSIFIER_USAGE}`, "error");
				return;
			}

			if (parsed.kind === "status") {
				ctx.ui.notify(buildClassifierStatusReport(ctx), "info");
				return;
			}

			if (parsed.kind === "help") {
				ctx.ui.notify(CLASSIFIER_HELP_TEXT, "info");
				return;
			}

			if (parsed.kind === "clear") {
				const patch: Partial<ApprovalConfigFile> = {};
				const clearAll = parsed.targets.length === 0 || parsed.targets.includes("--both");

				if (clearAll || parsed.targets.includes("--stage1")) {
					customClassifierStage1Model = undefined;
					patch.classifierStage1Model = undefined;
				}
				if (clearAll || parsed.targets.includes("--stage2")) {
					customClassifierStage2Model = undefined;
					patch.classifierStage2Model = undefined;
				}
				if (clearAll) {
					customClassifierModel = undefined;
					patch.classifierModel = undefined;
				}

				saveGlobalApprovalConfig(patch);
				const clearedDesc = clearAll ? "全部分类器模型配置" : parsed.targets.join(" ");
				ctx.ui.notify(`已清除分类器模型配置 (${clearedDesc})\n\n${buildClassifierStatusReport(ctx)}`, "info");
				return;
			}

			if (parsed.kind === "set") {
				// D1: 全有或全无校验
				for (const pair of parsed.pairs) {
					const check = validateClassifierModelRef(ctx, pair.model, pair.flag);
					if (!check.ok) {
						ctx.ui.notify(
							`"${pair.flag}" 的模型值 "${pair.model}" 无效：${check.reason}（期望 <provider>/<model>）\n整条命令未保存（全有或全无）\n\n${CLASSIFIER_USAGE}`,
							"error",
						);
						return;
					}
				}

				// 全部有效后生效并落盘
				const patch: Partial<ApprovalConfigFile> = {};
				for (const pair of parsed.pairs) {
					if (pair.flag === "--stage1") {
						customClassifierStage1Model = pair.model;
						patch.classifierStage1Model = pair.model;
					} else if (pair.flag === "--stage2") {
						customClassifierStage2Model = pair.model;
						patch.classifierStage2Model = pair.model;
					} else if (pair.flag === "--both") {
						customClassifierModel = pair.model;
						customClassifierStage1Model = undefined;
						customClassifierStage2Model = undefined;
						patch.classifierModel = pair.model;
						patch.classifierStage1Model = undefined;
						patch.classifierStage2Model = undefined;
					}
				}

				saveGlobalApprovalConfig(patch);
				const savedDesc = parsed.pairs.map((p) => `${p.flag} → ${p.model}`).join(", ");
				ctx.ui.notify(`已保存分类器模型配置: ${savedDesc}\n\n${buildClassifierStatusReport(ctx)}`, "info");
				return;
			}
		},
	});

	// 4. 注册快捷键：Ctrl+Alt+A 快速循环切换模式
	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "循环切换审批模式 (Approval Mode)",
		handler: async (ctx) => {
			cycleApprovalMode(ctx);
		},
	});

	// 5. 提示词动态增强（针对 Plan 模式）与新一轮摩擦预算重置
	pi.on("before_agent_start", async () => {
		denialTracker.resetTurnDenials();

		if (currentMode === "plan") {
			return {
				message: {
					customType: "approval-plan-instructions",
					content: `[PLAN MODE ACTIVE]
当前处于【只读探索模式 (Plan Mode)】：
- 写入和编辑工具 (edit, write) 已被禁用。
- Shell 命令仅允许执行常规只读检索与检查。
- 请专注于深入分析代码、理解需求与架构，并在回复中以 "Plan:" 为标题输出清晰的分步实施计划。
- 严禁尝试做实质性文件修改。计划确认后用户将切换模式进行实施。`,
					display: false,
				},
			};
		}
	});

	/**
	 * 获取近期对话与工具调用摘要（薄封装：取 entries 后交给 buildTranscript 纯函数）。
	 */
	function getRecentConversationTranscript(ctx: ExtensionContext): string {
		try {
			const entries = ctx.sessionManager.getBranch();
			return buildTranscript(entries as any, ctx.cwd).join("\n\n");
		} catch {
			return "";
		}
	}

	// resolveClassifierModel extracted to top level
	
	/**
	 * 离线/降级安全兜底规则校验 (启发式风控)
	 */


	async function runTwoStageClassifier(
		ctx: ExtensionContext,
		toolName: string,
		toolInput: Record<string, any>,
	): Promise<{ shouldBlock: boolean; reason: string; stage: "fast" | "thinking" | "fallback"; outage?: boolean }> {
		const resolvedStage1 = resolveClassifierModel(ctx, customClassifierStage1Model, getEffectiveSharedModel("Stage 1", ctx), false, "Stage 1");
		const resolvedStage2 = resolveClassifierModel(ctx, customClassifierStage2Model, getEffectiveSharedModel("Stage 2", ctx), false, "Stage 2", false);

		if (ctx.hasUI) {
			for (const res of [resolvedStage1, resolvedStage2]) {
				if (res.fallbackReason && res.configValue) {
					const key = `${res.stageName}:${res.configValue}:${res.fallbackReason}`;
					if (!notifiedFallbacks.has(key)) {
						notifiedFallbacks.add(key);
						ctx.ui.notify(
							`[ApprovalMode] ${res.stageName} 分类器模型配置 (${res.configValue}) 无效，已降级 (原因: ${res.fallbackReason})。当前生效模型: ${res.label}`,
							"warning",
						);
					}
				}
			}
		}

		const s1Model = resolvedStage1.model;
		const s2Model = resolvedStage2.model;

		const transcript = getRecentConversationTranscript(ctx);
		const projectedInput = projectToolInput(toolName, toolInput, ctx.cwd);
		const promptContent =
			`Conversation Transcript:\n${transcript}\n\n` +
			`## Pending tool call to classify\n\n` +
			`Tool: ${toolName}\nArguments:\n${JSON.stringify(projectedInput, null, 2)}`;

		// === Stage 1: 极速初筛 (带超时熔断保护与独立健康追踪， Module A /  原生 classify 派发) ===
		const isS1Classifier = s1Model?.type === "classifier";
		const hasS1Auth = Boolean(s1Model && ctx.modelRegistry.hasConfiguredAuth(s1Model));

		if (s1Model && hasS1Auth) {
			let s1Failure: Stage1FailureReason | null = null;

			if (isS1Classifier) {
				// 原生 System One classifier：传输/认证/重试由 registry.classify() 承担（永不 reject），
				// 超时经 AbortController + 竞速兑底收敛，失败统一归因进独立健康度追踪。
				const outcome = await classifyStage1(ctx.modelRegistry, s1Model, promptContent, classifierTimeoutMs);
				if (outcome.ok) {
					const prevStatus = stageHealthTracker.getStatus().status;
					stageHealthTracker.recordStage1Success();
					if (prevStatus === "degraded") {
						updateStatus(ctx);
					}
					if (outcome.shouldBlock === false) {
						denialTracker.recordClassifierActive();
						return { shouldBlock: false, reason: "", stage: "fast" };
					}
					// shouldBlock === true: Stage 1 标记可疑，流转 Stage 2 深度复核
				} else {
					s1Failure = outcome.failure ?? "upstream_error";
				}
			} else {
				let stage1Response: any = null;
				try {
					const stage1Promise = ctx.modelRegistry.complete(
						s1Model,
						{
							systemPrompt: CLASSIFIER_BASE_PROMPT + STAGE1_SUFFIX,
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: promptContent }],
									timestamp: Date.now(),
								},
							],
						},
						{ cacheRetention: "none" },
					);
					stage1Response = await withTimeout(stage1Promise, classifierTimeoutMs, null);
					if (!stage1Response) {
						s1Failure = "timeout";
					}
				} catch {
					s1Failure = "exception";
				}

				if (stage1Response) {
					const s1Err =
						(stage1Response as any).stopReason === "error" || (stage1Response as any).errorMessage
							? String((stage1Response as any).errorMessage || "unknown upstream error")
							: null;
					if (s1Err !== null) {
						s1Failure = "upstream_error";
					} else {
						const stage1Text = stage1Response.content
							.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
							.map((c: any) => c.text)
							.join("\n");
						const stage1Json = parseClassifierJson(stage1Text);
						if (stage1Json && typeof stage1Json.shouldBlock === "boolean") {
							const prevStatus = stageHealthTracker.getStatus().status;
							stageHealthTracker.recordStage1Success();
							if (prevStatus === "degraded") {
								updateStatus(ctx);
							}
							if (stage1Json.shouldBlock === false) {
								denialTracker.recordClassifierActive();
								return { shouldBlock: false, reason: "", stage: "fast" };
							}
							// shouldBlock === true: Stage 1 标记可疑，流转 Stage 2 深度复核
						} else {
							s1Failure = "invalid_response";
						}
					}
				}
			}

			if (s1Failure !== null) {
				const { transitioned, escalated } = stageHealthTracker.recordStage1Failure(s1Failure);
				if (transitioned) {
					updateStatus(ctx);
					if (!stageHealthTracker.hasWarnedDegraded()) {
						stageHealthTracker.setWarnedDegraded(true);
						if (ctx.ui?.notify) {
							ctx.ui.notify(
								`⚠️ 分类器 Stage 1 快速快筛响应异常 (${s1Failure})，已自动由 Stage 2 深度复核接管。`,
								"warning",
							);
						}
					}
				}
				if (escalated) {
					if (ctx.ui?.notify) {
						ctx.ui.notify(
							`⚠️ 分类器 Stage 1 快速快筛已连续失败 5 次 (当前所有调用均由 Stage 2 深度复核接管，审批延迟增加)。建议执行 /classifier-model 检查或切换 Stage 1 快筛模型。`,
							"warning",
						);
					}
				}
				// 严禁误计入共享 consecutiveUnavailable! (Stage 2 成功仍保证分类器整体可用)
			}
		}

		// Stage 1 failed or flagged -> proceed to Stage 2

		// 检查 Stage 2 模型是否可用
		if (!s2Model || !ctx.modelRegistry.hasConfiguredAuth(s2Model)) {
			denialTracker.recordUnavailable();
			const heuristic = fallbackHeuristicCheck(toolName, toolInput, ctx.cwd);
			return {
				...heuristic,
				stage: "fallback",
			};
		}

		// === Stage 2: 深度推理复核 (带超时熔断保护) ===
		let stage2Response: any = null;
		try {
			const stage2Promise = ctx.modelRegistry.complete(
				s2Model,
				{
					systemPrompt: CLASSIFIER_BASE_PROMPT + STAGE2_SUFFIX,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: promptContent }],
							timestamp: Date.now(),
						},
					],
				},
				{ cacheRetention: "none" },
			);

			stage2Response = await withTimeout(stage2Promise, classifierStage2TimeoutMs, null);
		} catch {
			denialTracker.recordUnavailable();
			return {
				shouldBlock: true,
				reason: DENIAL_MESSAGES.singleUnavailable("stage2_exception"),
				stage: "fallback",
				outage: true
			};
		}

		if (!stage2Response) {
			denialTracker.recordUnavailable();
			return {
				shouldBlock: true,
				reason: DENIAL_MESSAGES.singleUnavailable(`stage2_timeout(${classifierStage2TimeoutMs}ms)`),
				stage: "fallback",
				outage: true
			};
		}

		// ：上游错误 ≠ 解析失败。stopReason=error（如 content_filter）是
		// provider 对请求本身的拒绝，不是 JSON 解析问题——分型归因避免排障被误导。
		const s2Err =
			(stage2Response as any).stopReason === "error" || (stage2Response as any).errorMessage
				? String((stage2Response as any).errorMessage || "unknown upstream error")
				: null;
		if (s2Err !== null) {
			denialTracker.recordUnavailable();
			const upstreamCode = (s2Err.match(/finish_reason:\s*([\w]+)/i)?.[1] || s2Err).slice(0, 60);
			return {
				shouldBlock: true,
				reason: s2Err.includes("content_filter")
					? DENIAL_MESSAGES.classifierContentFilter(toolName)
					: DENIAL_MESSAGES.classifierUpstreamError(upstreamCode, toolName),
				stage: "fallback",
				outage: true
			};
		}

		const stage2Text = stage2Response.content
			.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");

		const stage2Json = parseClassifierJson(stage2Text);
		if (stage2Json && typeof stage2Json.shouldBlock === "boolean") {
			denialTracker.recordClassifierActive();
			return {
				shouldBlock: stage2Json.shouldBlock,
				reason: stage2Json.reason || "Safety classifier flagged this action as potentially unsafe",
				stage: "thinking",
			};
		}

		denialTracker.recordUnavailable();
		return {
			shouldBlock: true,
			reason: DENIAL_MESSAGES.singleUnavailable("stage2_json_parse_fail"),
			stage: "fallback",
			outage: true
		};
	}

	/**
	 * 弹出支持数字快捷键单键直选、高度预算控制与详情折叠的审批面板 (Custom TUI Dialog)
	 */
	async function promptApprovalDialog(
		ctx: ExtensionContext,
		title: string,
		details: Array<{ label: string; content: string }>,
		isLoop = false,
		denyByDefault = false,
		toolCallId?: string,
	): Promise<ApprovalAction> {
		const options: ApprovalOption[] = isLoop ? [...APPROVAL_OPTIONS, LOOP_ABORT_OPTION] : APPROVAL_OPTIONS;

		// 可靠解析当前批次进度（若可得）并注入标题
		const effectiveToolCallId = toolCallId ?? currentToolCallId;
		const batchProgress = resolveBatchProgress(ctx.sessionManager, effectiveToolCallId);
		const effectiveTitle = formatDialogTitleWithBatch(title, batchProgress);

		// 展示前安全转义不可信详情内容（防御终端注入、消除 Tab 宽度漂移、阻断 Bidi 视觉欺骗）
		let totalControl = 0;
		let totalTab = 0;
		let totalBidi = 0;
		const sanitizedDetails = details.map((item) => {
			const res = sanitizeUntrustedDetail(item.content);
			totalControl += res.escapedControlCount;
			totalTab += res.escapedTabCount;
			totalBidi += res.escapedBidiCount;
			return { label: item.label, content: res.text };
		});
		const totalEscaped = totalControl + totalTab + totalBidi;
		const hasSanitized = totalEscaped > 0;

		if (ctx.mode === "tui") {
			const result = await ctx.ui.custom<ApprovalAction | null>((tui, theme, _kb, done) => {
				// ：指纹短路弹窗默认拒绝态（光标停在 Block；Esc 本就=拒绝）
				let selectedIndex = denyByDefault ? Math.max(0, options.findIndex((o) => o.action === "block")) : 0;
				// 详情折叠/展开状态
				let isExpanded = false;
				let hasFoldableDetails = false;

				function refresh() {
					tui.requestRender();
				}

				return {
					handleInput(data: string) {
						// 0. 弹窗内切换审批模式（设计 A：不关闭弹窗，本次待审调用仍由用户手动裁决）
						if (matchesKey(data, Key.ctrlAlt("a"))) {
							cycleApprovalMode(ctx, true);
							refresh();
							return;
						}

						// 折叠/展开快捷键 (v, V, Ctrl+O / \x0f)
						if (
							data === "v" ||
							data === "V" ||
							data === "\x0f" ||
							matchesKey(data, Key.ctrl("o"))
						) {
							isExpanded = !isExpanded;
							refresh();
							return;
						}

						// 键盘翻页穿透 (特性探测：若无安全可靠扩展 API 则不假装滚动)
						const scrollApi = (ctx.ui as any)?.scrollTranscript;
						if (typeof scrollApi === "function") {
							if (matchesKey(data, Key.pageUp) || data === "\x1b[5~" || data === "\x1b[1;2A") {
								try {
									scrollApi.call(ctx.ui, "page-up");
								} catch {}
								return;
							}
							if (matchesKey(data, Key.pageDown) || data === "\x1b[6~" || data === "\x1b[1;2B") {
								try {
									scrollApi.call(ctx.ui, "page-down");
								} catch {}
								return;
							}
						}

						// 1. 单键直接按数字键 1 - 6 瞬间选择
						const num = parseInt(data, 10);
						if (!isNaN(num) && num >= 1 && num <= options.length) {
							done(options[num - 1].action);
							return;
						}

						// 2. 方向键或 j/k 移动光标
						if (matchesKey(data, Key.up) || data === "k") {
							selectedIndex = (selectedIndex - 1 + options.length) % options.length;
							refresh();
							return;
						}
						if (matchesKey(data, Key.down) || data === "j") {
							selectedIndex = (selectedIndex + 1) % options.length;
							refresh();
							return;
						}

						// 3. 回车确认当前光标项
						if (matchesKey(data, Key.enter)) {
							done(options[selectedIndex].action);
							return;
						}

						// 4. Esc 或 q 键拒绝
						if (matchesKey(data, Key.escape) || data === "q") {
							done("block");
							return;
						}
					},

					render(width: number): string[] {
						const safeWidth = Math.max(10, width);
						const lines: string[] = [];

						// 基于终端真实行数动态计算高度预算
						const terminalRows = tui?.terminal?.rows ?? (process.stdout?.rows || 24);
						const budget = calculateHeightBudget(terminalRows);

						// ：视口宽度内自适应换行（不再按行截断省略），续行按缩进对齐
						const addLine = (str: string, indent = "", contIndent = indent) => {
							for (const l of wrapDialogLine(str, safeWidth, indent, contIndent)) lines.push(l);
						};

						// 顶部线条与标题
						addLine(theme.fg("accent", "─".repeat(safeWidth)));
						addLine(theme.fg("accent", theme.bold(effectiveTitle)), " ");
						if (!budget.isDegraded) {
							addLine(theme.fg("accent", `当前审批模式: ${currentMode}  (按 Ctrl+Alt+A 可切换)`), " ");
						}
						if (hasSanitized) {
							addLine(
								theme.fg(
									"warning",
									`⚠️ 展示安全提醒：检测到 ${totalEscaped} 处特殊控制字符（已转义展示）。批准后将按原始参数执行。`,
								),
								" ",
							);
						}
						if (!budget.isDegraded) {
							addLine("");
						}

						// 详细信息展示区（带高度预算折叠、连续空行合并、超长单逻辑行保护）
						hasFoldableDetails = false;
						for (const item of sanitizedDetails) {
							addLine(`${theme.fg("muted", item.label)}:`, "  ");
							const formatted = formatFoldableDetail(
								{
									content: item.content,
									width: safeWidth,
									isExpanded,
									indent: "    ",
									contIndent: "    ",
									maxExpandedLines: isExpanded ? 50 : budget.maxDetailsLines,
								},
								theme,
							);
							if (formatted.isFoldable) {
								hasFoldableDetails = true;
							}
							for (const fl of formatted.lines) {
								lines.push(fl);
							}
						}

						if (!budget.isDegraded) {
							addLine("");
							addLine(theme.fg("muted", `请选择审批动作 (支持直接按数字键 1-${options.length} 快速选择):`), "  ");
						}
						addLine("");

						// 渲染编号选项（矮终端降级模式下省略 description 节省纵向空间，确保核心选项与底栏不被裁切）
						for (let i = 0; i < options.length; i++) {
							const opt = options[i];
							const isSelected = i === selectedIndex;
							const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
							const numTag = theme.fg(isSelected ? "accent" : "muted", `${i + 1}. `);
							const labelText = theme.fg(isSelected ? "accent" : "text", opt.label);

							// 前缀（光标箭头 + 编号）作为首行缩进，续行用等宽空格对齐到 label 起始列
							const firstPrefix = `${prefix}${numTag}`;
							addLine(labelText, firstPrefix, " ".repeat(visibleWidth(firstPrefix)));
							if (opt.description && !budget.isDegraded) {
								addLine(theme.fg("dim", opt.description), "     ");
							}
						}

						if (!budget.isDegraded) {
							addLine("");
						}
						// 底栏快捷提示：自适应终端高度与能力探测
						const foldHint = hasFoldableDetails ? " | [v / Ctrl+O] 展开/折叠" : "";
						const scrollHint = typeof (ctx.ui as any)?.scrollTranscript === "function" ? " | [PgUp/PgDn] 翻阅历史" : "";
						if (budget.isDegraded) {
							addLine(
								theme.fg(
									"muted",
									`[快捷提示] 1-${options.length} 选择${hasFoldableDetails ? " | v 展开/折叠" : ""} | ↑/↓ 移动 | Enter 确认 | Esc 拒绝`,
								),
								"  ",
							);
						} else {
							addLine(
								theme.fg(
									"muted",
									`[快捷提示] 按 1-${options.length} 直接选择${foldHint} | ↑/↓ 移动 | Enter 确认 | Esc 拒绝 | Ctrl+Alt+A 切换模式${scrollHint}`,
								),
								"  ",
							);
						}
						addLine(theme.fg("accent", "─".repeat(safeWidth)));

						return lines;
					},
				};
			});

			return result ?? "block";
		}

		// RPC 或无完整 TUI 终端模式时的优雅降级
		if (ctx.hasUI) {
			const items = options.map((opt, i) => `${i + 1}. ${opt.label} (${opt.description})`);
			const promptBody = `${effectiveTitle}\n\n${sanitizedDetails.map((d) => `${d.label}:\n  ${d.content}`).join("\n")}`;
			const selected = await ctx.ui.select(promptBody, items);
			if (!selected) return "block";

			const num = parseInt(selected.charAt(0), 10);
			if (!isNaN(num) && num >= 1 && num <= options.length) {
				return options[num - 1].action;
			}
		}

		return "block";
	}

	function allowCall(toolName: string, input: Record<string, any>): undefined {
		loopDetector.recordSuccess(toolName, input);
		denialTracker.recordAllow();
		return undefined;
	}

	/**
	 * 分类器连续不可用熔断是否已触顶（交互降级启发式的判据）
	 *
	 * 不能复用 checkFallback().kind： 后人工拒绝也计入 consecutiveBlock，
	 * 而 consecutiveBlock 触顶时 kind 会是 consecutive_block，把“不可用”降级电路顶掉，
	 * 故障窗口的重复弹窗抑制（本单预期的实现路径）随之失效。故直接读不可用计数。
	 */
	function unavailableCircuitTripped(): boolean {
		const stats = denialTracker.getStats();
		return stats.consecutiveUnavailable >= denialTracker.getLimits().maxConsecutiveUnavailable;
	}

	function blockCall(
		toolName: string,
		input: Record<string, any>,
		reason: string,
		terminate = false,
		countAsDenial = true,
	): ToolCallEventResult {
		// 统计归属：分类器故障引发的**自动拦截**只计入“不可用”计数，
		// 不灌入“拒绝”类统计（consecutiveBlock/totalBlock/loop 连续被拒）——两套计数各司其职。
		// 仅无头自动拦截可用此豁免；用户在弹窗中的拒绝一律入账。
		// 口径（，宽口径保持）：拒绝类 = 一切明确说 no 的拦截（用户拒绝 / deny 规则 /
		// plan 拦截 / 熔断自拦）；“不可用”豁免仅限分类器 outage 的自动拦截（基线 M11 口径句）。
		if (countAsDenial) {
			loopDetector.recordDenial(toolName, input);
			const fingerprint = DenialTracker.createFingerprint(toolName, input);
			denialTracker.recordBlock(fingerprint);
		}
		const res: ToolCallEventResult = { block: true, reason };
		if (terminate) {
			(res as any).terminate = true;
		}
		return res;
	}

	/**
	 * 处理用户的审批选择并持久化为标准 Qwen Code DSL 规则
	 *
	 * 本函数只承载“人在弹窗里的决定”，因此拒绝一律计入拒绝侧统计；
	 * 分类器故障的豁免只适用于无头自动拦截（blockCall 的 countAsDenial）。
	 */
	async function handleOutcome(
		action: ApprovalAction,
		dslRule: string,
		ctx: ExtensionContext,
		label: string,
		toolName: string,
		input: Record<string, any>,
		fromCircuitFallback = false, // ：本次弹窗是否因熔断跳过分类器而产生（Qwen wasAutoModeFallback 同款判据）
	): Promise<ToolCallEventResult | undefined> {
		// （Qwen Code v2 同款）：仅「触顶后跳过分类器的 fallback 弹窗」上的
		// 人工批准是自愈触发器——清连击计数，下次判定重新交分类器；
		// 分类器真实跑过但失败的故障弹窗批准不清（0027-A/D1 语义保持）；
		// 拒绝路径不清（拒绝视为分类器判对）。
		if (
			(action === "allow_once" || action === "allow_session" ||
			 action === "allow_project" || action === "allow_user") &&
			fromCircuitFallback && unavailableCircuitTripped()
		) {
			denialTracker.recordFallbackApprove();
		}
		switch (action) {
			case "allow_once":
				return allowCall(toolName, input);

			case "allow_session": {
				const res = permissionManager.addRule("allow", dslRule, "session");
				if (res.warning) {
					ctx.ui.notify(res.warning, "warning");
				} else if (res.stashed) {
					ctx.ui.notify(`⚠️ auto 模式下该 allow 规则过于宽泛，已暂存不生效（退出 auto 自动恢复）: ${dslRule}`, "warning");
				} else {
					ctx.ui.notify(`已加入会话免审白名单: ${dslRule}`, "info");
				}
				return allowCall(toolName, input);
			}

			case "allow_project": {
				const res = permissionManager.addRule("allow", dslRule, "project");
				if (res.warning) {
					ctx.ui.notify(res.warning, "warning");
				} else if (res.stashed) {
					ctx.ui.notify(`⚠️ auto 模式下该 allow 规则过于宽泛，已暂存不生效（退出 auto 自动恢复）: ${dslRule}`, "warning");
				} else {
					ctx.ui.notify(`已加入项目级免审白名单: ${dslRule} (.pi/approval-rules.json)`, "info");
				}
				return allowCall(toolName, input);
			}

			case "allow_user": {
				const res = permissionManager.addRule("allow", dslRule, "user");
				if (res.warning) {
					ctx.ui.notify(res.warning, "warning");
				} else if (res.stashed) {
					ctx.ui.notify(`⚠️ auto 模式下该 allow 规则过于宽泛，已暂存不生效（退出 auto 自动恢复）: ${dslRule}`, "warning");
				} else {
					ctx.ui.notify(`已加入全局用户级免审白名单: ${dslRule} (~/.pi/agent/approval-rules.json)`, "info");
				}
				return allowCall(toolName, input);
			}

			case "block_and_abort":
				if (ctx.ui?.setStatus) {
					ctx.ui.setStatus("用户拒绝执行并要求中止当前推进方向");
				}
				return blockCall(
					toolName,
					input,
					formatUserAbortReasonForAgent(),
				);

			case "block":
			default:
				if (ctx.ui?.setStatus) {
					ctx.ui.setStatus("已由用户手动拒绝执行");
				}
				return blockCall(toolName, input, formatUserRejectionReasonForAgent(label));
		}
	}

	// 6. 核心门禁控制：拦截 tool_call
	pi.on("tool_call", async (event, ctx) => {
		const { toolName } = event;
		currentToolCallId = (event as any).toolCallId;
		const input = (event.input ?? {}) as Record<string, any>;

		if (!permissionManager) {
			const isTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
			permissionManager = new PermissionManager(ctx.cwd, undefined, undefined, isTrusted);
		}

		// ==============================================================
		// 步骤 -1: 死循环与连续失败统计熔断器 (Loop & Stagnation Detection)
		// ==============================================================
		const loopCheck = loopDetector.checkBeforeExecution(toolName, input);
		if (loopCheck.isLoop) {
			// ：无头语境下模型既没有弹窗可点、也没有“策略”可转——会话已被
			// loop 熔断先手拦截后续一切调用（且拦截自灌 recordDenial，除非人工介入不会归零）。
			// 因此无头 reason 一律改用熔断口径：明示会话已停 + 需人工介入，
			// 不再复用 warningMessage 里“转换策略 / 选择拒绝并指示停止”这类只对交互侧成立的行动指引。
			const headlessFused = DENIAL_MESSAGES.headlessCircuitFused(
				loopCheck.loopType || "loop",
				loopCheck.streak,
			);

			// 硬上限触发：即使在交互模式下也直接强行熔断，不再弹窗骚扰用户
			if (loopCheck.isHardLimit) {
				ctx.ui.notify(loopCheck.warningMessage || "死循环已达硬上限，已强制熔断！", "error");
				return blockCall(
					toolName,
					input,
					ctx.hasUI
						? DENIAL_MESSAGES.circuitBreaker(loopCheck.warningMessage || "Hard limit reached")
						: headlessFused,
					false,
				);
			}

			// 处于 yolo 模式下一律即刻阻断，不穿透放行！
			// terminate 恒为 false，将结构化 Agent 报错注入上下文赋予 Model 自主决策与纠错空间。
			if (currentMode === "yolo") {
				if (ctx.hasUI) {
					ctx.ui.notify("🚨 检测到连续 3 次相同工具调用，已暂停并交由模型调整", "warning");
				}
				const agentReason = formatLoopReasonForAgent(loopCheck);
				return blockCall(toolName, input, agentReason, false);
			}

			// 在无头模式 (Headless / !ctx.hasUI) 下：直接快速失败，强制阻断死循环！
			if (!ctx.hasUI) {
				return blockCall(toolName, input, headlessFused);
			}
		}

		// ==============================================================
		// 步骤 0: Qwen Code 预设权限体系仲裁 (Deny > Ask > Allow > Default)
		// ==============================================================
		const permDecision = permissionManager.evaluate({
			cwd: ctx.cwd,
			toolName,
			input,
		});

		// 1) 命中 Deny 规则：最高优先级硬性阻断，不弹窗，直接向模型反馈错误
		if (permDecision.decision === "deny") {
			if (ctx.hasUI) {
				ctx.ui.notify(`🛑 命中禁止规则: ${permDecision.matchedRule}，已阻断执行`, "error");
			}
			return blockCall(
				toolName,
				input,
				formatDenyReasonForAgent(permDecision.matchedRule || ""),
			);
		}

		// 2) 命中 Ask 规则：强制弹窗人工确认（压倒任何免审模式）
		if (permDecision.decision === "ask") {
			if (!ctx.hasUI) {
				return blockCall(
					toolName,
					input,
					DENIAL_MESSAGES.presetAskHeadless(permDecision.matchedRule || ""),
				);
			}

			const label = toolName === "bash" ? input.command || "bash" : input.path || toolName;
			const dslRule =
				toolName === "bash"
					? `Bash(${input.command})`
					: isReadOnlyTool(toolName)
						? buildReadDslRule(String(input.path ?? ""))
						: `Edit(${relative(ctx.cwd, input.path || "").replace(/\\/g, "/")})`;

			const dialogDetails: Array<{ label: string; content: string }> = [];
			if (loopCheck.isLoop && loopCheck.warningMessage) {
				dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
			}
			dialogDetails.push({ label: "命中规则", content: permDecision.matchedRule || "" });
			dialogDetails.push({ label: "调用目标", content: label });

			const action = await promptApprovalDialog(
				ctx,
				formatDialogTitle("⚠️ [预设权限人工核准 (Ask Rule)]", "Ask Rule", loopCheck),
				dialogDetails,
				loopCheck.isLoop,
			);

			return handleOutcome(action, dslRule, ctx, label, toolName, input);
		}

		// 3) 命中 Allow 规则：免审放行（在非受保护文件下直接通过）
		if (permDecision.decision === "allow") {
			// 如果是文件修改且命中了极端敏感路径，保留安全底线；其他一律放行
			if (toolName === "edit" || toolName === "write") {
				const filePath = (input.path || input.target_file || "").replace(/\\/g, "/");
				if (!isProtectedPath(filePath)) {
					return allowCall(toolName, input);
				}
			} else {
				return allowCall(toolName, input);
			}
		}

		// ==============================================================
		// 步骤 0.5: 工具默认权限层
		// 仅当未命中显式规则（decision === "default" 且无 matchedRule）时，
		// 读类工具用工具默认权限兑底：工作区内 allow 快路径 / 工作区外 ask 人工。
		// 命中 default 规则（matchedRule 有值）或非读类工具 → 继续走模式漏斗。
		// ==============================================================
		if (
			permDecision.decision === "default" &&
			!permDecision.matchedRule &&
			isReadOnlyTool(toolName)
		) {
			const targetPath = String(input.path ?? "").trim();
			const isTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
			const toolDefault = getToolDefaultPermission(toolName, targetPath, ctx.cwd, isTrusted);

			// 工作区内读取 → 快路径放行（不进 classifier）
			if (toolDefault === "allow") {
				return allowCall(toolName, input);
			}

			// 工作区外读取 → 人工确认
			if (!ctx.hasUI) {
				return blockCall(
					toolName,
					input,
					DENIAL_MESSAGES.presetAskHeadless(`Read(${targetPath || toolName})`),
				);
			}

			const label = targetPath || toolName;
			const dslRule = buildReadDslRule(targetPath);
			const dialogDetails: Array<{ label: string; content: string }> = [];
			if (loopCheck.isLoop && loopCheck.warningMessage) {
				dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
			}
			dialogDetails.push({ label: "越界读取", content: label });

			const action = await promptApprovalDialog(
				ctx,
				formatDialogTitle("🛡️ [工作区外读取审批]", "越界读取", loopCheck),
				dialogDetails,
				loopCheck.isLoop,
			);

			return handleOutcome(action, dslRule, ctx, label, toolName, input);
		}

		// ==============================================================
		// 步骤 1: 运行模式漏斗裁决 (Approval Mode State Machine)
		// ==============================================================

		// 0) 命中 default 规则的读类工具 → 模式漏斗矩阵
		// 能到达此处的读类工具均命中了 default 规则（未命中的已在步骤 0.5 按工具默认权限处置）
		if (isReadOnlyTool(toolName)) {
			const disposition = resolveReadDisposition(currentMode);
			const targetPath = String(input.path ?? "").trim();
			const label = targetPath || toolName;
			const dslRule = buildReadDslRule(targetPath);

			// yolo / plan：放行（plan 只读语义）
			if (disposition === "allow") {
				return allowCall(toolName, input);
			}

			// auto：双阶段 LLM 安全分类器研判（交互不通过转人工、非交互不通过拒绝）
			if (disposition === "classifier") {
				const fingerprint = DenialTracker.createFingerprint(toolName, input);
				const fallback = denialTracker.checkFallback(fingerprint);
				if (fallback.shouldFallback && !ctx.hasUI) {
					const terminate = fallback.kind === "total_denial" && denialTracker.shouldAbortOnCap();
					return blockCall(toolName, input, fallback.reasonText || "Blocked", terminate, fallback.kind !== "consecutive_unavailable");
				}

				// ：交互侧按优先级消费 fallback——
				// ① total_denial 达顶 → 直接拒绝（不跑分类器）+ 解除指引；② 不可用触顶 → 既有启发式降级保持；
				// ③ classifier_blocked_retry 指纹命中 → 跳过分类器直接人审弹窗（基线 M10：不重复研判/不重复弹窗，默认拒绝态）；
				// ④ 其余 → 跑分类器（现状）。consecutive_block 交互侧不消费（0027 非目标，由 ① 的上限与弹窗承接）。
				if (ctx.hasUI && fallback.kind === "total_denial") {
					ctx.ui.notify(
						"⛔ 已达会话拒绝上限，后续被判风险的操作将直接拒绝；如需解除请配置 allow 规则或切换审批模式。",
						"warning",
					);
					return blockCall(toolName, input, fallback.reasonText || "Blocked: session denial cap reached");
				}

				if (ctx.hasUI && !unavailableCircuitTripped() && fallback.kind === "classifier_blocked_retry") {
					denialTracker.consumePendingFingerprint();
					const retryDialog: Array<{ label: string; content: string }> = [];
					if (loopCheck.isLoop && loopCheck.warningMessage) {
						retryDialog.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
					}
					retryDialog.push({ label: "读取目标", content: label });
					retryDialog.push({ label: "重复被拦短路（已跳过分类器，原样重试不再重复研判）", content: fallback.reasonText || DENIAL_MESSAGES.classifierBlockedRetry() });
					const retryAction = await promptApprovalDialog(
						ctx,
						formatDialogTitle("⚖️ [重复被拦读取人工核准 (Auto Mode)]", "重复读取被拦", loopCheck),
						retryDialog,
						loopCheck.isLoop,
						true,
					);
					return handleOutcome(retryAction, dslRule, ctx, label, toolName, input);
				}

				// ：在触顶判断时点捕获（弹窗时现算会被失败计数翻转污染）
				const circuitFallbackRead = unavailableCircuitTripped();
				let decision: { shouldBlock: boolean; reason: string; stage: "fast" | "thinking" | "fallback"; outage?: boolean };
				if (circuitFallbackRead) {
					decision = fallbackHeuristicCheck(toolName, input, ctx.cwd);
				} else {
					decision = await runTwoStageClassifier(ctx, toolName, input);
				}

				if (!decision.shouldBlock) {
					return allowCall(toolName, input);
				}

				if (!ctx.hasUI) {
					return blockCall(toolName, input, DENIAL_MESSAGES.autoReadBlocked(decision.reason, label), false, !decision.outage);
				}

				denialTracker.consumePendingFingerprint();

				const classifierDialog: Array<{ label: string; content: string }> = [];
				if (loopCheck.isLoop && loopCheck.warningMessage) {
					classifierDialog.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
				}
				// ：降级态的弹窗不是分类器结论——明示降级状态与自愈方式，
				// 避免把启发式规则的判断误认为分类器研判（含上游 filter 场景）。
				if (decision.stage === "fallback") {
					classifierDialog.push({
						label: "⚠️ 分类器无判决（降级为规则研判）",
						content: "分类器本次未能给出判决，已按启发式规则研判；人工批准一次即恢复分类器判定（连续无判决将自动熔断）。",
					});
				}
				classifierDialog.push({ label: "读取目标", content: label });
				classifierDialog.push({ label: "分类器研判风险", content: decision.reason });

				const classifierAction = await promptApprovalDialog(
					ctx,
					formatDialogTitle("⚖️ [读取安全分类器研判 (Auto Mode)]", "读取风险", loopCheck),
					classifierDialog,
					loopCheck.isLoop,
				);

				return handleOutcome(classifierAction, dslRule, ctx, label, toolName, input, circuitFallbackRead);
			}

			// auto-edit / default：人工确认
			if (!ctx.hasUI) {
				return blockCall(
					toolName,
					input,
					currentMode === "auto-edit"
						? DENIAL_MESSAGES.autoEditReadHeadless(label)
						: DENIAL_MESSAGES.manualReadHeadless(label),
				);
			}

			const readDialog: Array<{ label: string; content: string }> = [];
			if (loopCheck.isLoop && loopCheck.warningMessage) {
				readDialog.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
			}
			readDialog.push({ label: "读取目标", content: label });

			const readAction = await promptApprovalDialog(
				ctx,
				currentMode === "auto-edit"
					? formatDialogTitle("📝 [读取审批 (auto-edit)]", "读取", loopCheck)
					: formatDialogTitle("🛡️ [读取审批 (manual)]", "读取", loopCheck),
				readDialog,
				loopCheck.isLoop,
			);

			return handleOutcome(readAction, dslRule, ctx, label, toolName, input);
		}

		// 1) yolo 模式：除显式 deny 规则与死循环熔断已在前置拦截外，其余调用直接放行
		if (currentMode === "yolo") {
			return allowCall(toolName, input);
		}

		// 2) plan 模式：严格只读，工业级 Shell 分析
		if (currentMode === "plan") {
			if (toolName === "edit" || toolName === "write") {
				return blockCall(
					toolName,
					input,
					DENIAL_MESSAGES.planModeToolDisabled(toolName),
				);
			}

			if (toolName === "bash") {
				const cmd = (input.command || "").trim();
				const analysis = analyzeShellCommand(cmd);
				if (!analysis.isReadOnly) {
					return blockCall(
						toolName,
						input,
						DENIAL_MESSAGES.planModeCommandBlocked(cmd, analysis.reason || "non-read-only"),
					);
				}
			}
			return allowCall(toolName, input);
		}

		// 3) auto 模式：Qwen Code 同款三层过滤 + 工业级 Shell 状态机 + 双阶段 LLM 安全分类器
		if (currentMode === "auto") {
			// 文件编辑与写入处理 (Layer 1)
			if (toolName === "edit" || toolName === "write") {
				const filePath = (input.path || input.target_file || "").replace(/\\/g, "/");
				const relPath = relative(ctx.cwd, filePath).replace(/\\/g, "/");
				const dslRule = `Edit(${relPath})`;

				// 若修改的是受保护的核心配置或系统敏感文件，转入分类器研判
				if (isProtectedPath(filePath) || isProtectedPath(relPath) || isEscapingWorkspace(ctx.cwd, filePath)) {
					const fingerprint = DenialTracker.createFingerprint(toolName, input);
					const fallback = denialTracker.checkFallback(fingerprint);
					if (fallback.shouldFallback && !ctx.hasUI) {
						const terminate = fallback.kind === "total_denial" && denialTracker.shouldAbortOnCap();
						return blockCall(toolName, input, fallback.reasonText || "Blocked", terminate, fallback.kind !== "consecutive_unavailable");
					}

					// ：交互侧按优先级消费 fallback——
					// ① total_denial 达顶 → 直接拒绝（不跑分类器）+ 解除指引；
					// ②不可用触顶 → 跳过分类器直呈人工核准（保护等级不降，只甩掉挂掉的 LLM 等待，默认拒绝态）；
					// ③ classifier_blocked_retry 指纹命中 → 跳过分类器直接人审弹窗（基线 M10：不重复研判/不重复弹窗，默认拒绝态）；
					// ④ 其余 → 跑分类器（现状）。consecutive_block 交互侧不消费（0027 非目标，由 ① 的上限与弹窗承接）。
					if (ctx.hasUI && fallback.kind === "total_denial") {
						ctx.ui.notify(
							"⛔ 已达会话拒绝上限，后续被判风险的操作将直接拒绝；如需解除请配置 allow 规则或切换审批模式。",
							"warning",
						);
						return blockCall(toolName, input, fallback.reasonText || "Blocked: session denial cap reached");
					}

					// ② 不可用熔断触顶（直读计数，不看 kind——b/u 同涨时 kind 不可靠）→
					//    跳过分类器直呈人工核准（ 方案A：保护等级不降，只甩掉挂掉的 LLM 等待）
					if (ctx.hasUI && unavailableCircuitTripped()) {
						denialTracker.consumePendingFingerprint();
						const degradedDialog: Array<{ label: string; content: string }> = [];
						if (loopCheck.isLoop && loopCheck.warningMessage) {
							degradedDialog.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
						}
						degradedDialog.push({ label: "目标文件", content: relPath });
						degradedDialog.push({ label: "熔断降级", content: "分类器连续不可用已熔断，本调用已跳过分类器，保护路径直呈人工核准（默认拒绝态）。" });
						const degradedAction = await promptApprovalDialog(
							ctx,
							formatDialogTitle("⚖️ [受保护路径熔断人工核准 (Auto Mode)]", "保护路径熔断降级", loopCheck),
							degradedDialog,
							loopCheck.isLoop,
							true, // denyByDefault：光标停 Block（M10），同 C-3 机制
						);
						return handleOutcome(degradedAction, dslRule, ctx, relPath, toolName, input, true); // 触顶专用分支：跳过分类器的 fallback 弹窗
					}

					if (ctx.hasUI && !unavailableCircuitTripped() && fallback.kind === "classifier_blocked_retry") {
						denialTracker.consumePendingFingerprint();
						const retryDialog: Array<{ label: string; content: string }> = [];
						if (loopCheck.isLoop && loopCheck.warningMessage) {
							retryDialog.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
						}
						retryDialog.push({ label: "目标文件", content: relPath });
						retryDialog.push({ label: "重复被拦短路（已跳过分类器，原样重试不再重复研判）", content: fallback.reasonText || DENIAL_MESSAGES.classifierBlockedRetry() });
						const retryAction = await promptApprovalDialog(
							ctx,
							formatDialogTitle("⚖️ [重复被拦敏感路径修改人工核准 (Auto Mode)]", "重复敏感路径被拦", loopCheck),
							retryDialog,
							loopCheck.isLoop,
							true,
						);
						return handleOutcome(retryAction, dslRule, ctx, relPath, toolName, input);
					}

					const decision = await runTwoStageClassifier(ctx, toolName, input);
					if (!decision.shouldBlock) {
						return allowCall(toolName, input);
					}

					if (!ctx.hasUI) {
						return blockCall(
							toolName,
							input,
							DENIAL_MESSAGES.autoProtectedPath(decision.reason, relPath),
							false,
							!decision.outage,
						);
					}

					denialTracker.consumePendingFingerprint();

					const dialogDetails: Array<{ label: string; content: string }> = [];
					if (loopCheck.isLoop && loopCheck.warningMessage) {
						dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
					}
					dialogDetails.push({ label: "目标文件", content: relPath });
					// ：降级态标注（与 read/bash 分支同款——非分类器结论）
					if (decision.stage === "fallback") {
						dialogDetails.push({
							label: "⚠️ 分类器无判决（降级为规则研判）",
							content: "分类器本次未能给出判决，已按启发式规则研判；人工批准一次即恢复分类器判定（连续无判决将自动熔断）。",
						});
					}
					dialogDetails.push({ label: "拦截原因", content: decision.reason });

					const action = await promptApprovalDialog(
						ctx,
						formatDialogTitle("⚖️ [受保护敏感路径修改审批 (Auto Mode)]", "敏感路径修改", loopCheck),
						dialogDetails,
						loopCheck.isLoop,
					);

					return handleOutcome(action, dslRule, ctx, relPath, toolName, input);
				}

				// 常规工作区内部文件编辑/写入：快路径自动放行！
				return allowCall(toolName, input);
			}

			// Shell 命令处理 (Layer 3 分类器；Layer 2 只读免审已下线，分析仅余展示用途)
			if (toolName === "bash") {
				const cmd = (input.command || "").trim();
				const dslRule = `Bash(${cmd})`;

				// Layer 2 只读免审快路径下线——auto 下非规则命中的 bash 一律进分类器（交互与无头同口径）。
				// 分析调用保留，仅供弹窗"静态结构特征"展示行消费（展示≠裁决）。
				const shellAnalysis = analyzeShellCommand(cmd);

				// Layer 3: 双阶段 LLM 安全分类器研判
				const fingerprint = DenialTracker.createFingerprint(toolName, input);
				const fallback = denialTracker.checkFallback(fingerprint);
				if (fallback.shouldFallback && !ctx.hasUI) {
					const terminate = fallback.kind === "total_denial" && denialTracker.shouldAbortOnCap();
					return blockCall(toolName, input, fallback.reasonText || "Blocked", terminate, fallback.kind !== "consecutive_unavailable");
				}

				// ：交互侧按优先级消费 fallback——
				// ① total_denial 达顶 → 直接拒绝（不跑分类器）+ 解除指引；② 不可用触顶 → 既有启发式降级保持；
				// ③ classifier_blocked_retry 指纹命中 → 跳过分类器直接人审弹窗（基线 M10：不重复研判/不重复弹窗，默认拒绝态）；
				// ④ 其余 → 跑分类器（现状）。consecutive_block 交互侧不消费（0027 非目标，由 ① 的上限与弹窗承接）。
				if (ctx.hasUI && fallback.kind === "total_denial") {
					ctx.ui.notify(
						"⛔ 已达会话拒绝上限，后续被判风险的操作将直接拒绝；如需解除请配置 allow 规则或切换审批模式。",
						"warning",
					);
					return blockCall(toolName, input, fallback.reasonText || "Blocked: session denial cap reached");
				}

				if (ctx.hasUI && !unavailableCircuitTripped() && fallback.kind === "classifier_blocked_retry") {
					denialTracker.consumePendingFingerprint();
					const retryDialog: Array<{ label: string; content: string }> = [];
					if (loopCheck.isLoop && loopCheck.warningMessage) {
						retryDialog.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
					}
					retryDialog.push({ label: "准备执行命令", content: cmd });
					retryDialog.push({ label: "重复被拦短路（已跳过分类器，原样重试不再重复研判）", content: fallback.reasonText || DENIAL_MESSAGES.classifierBlockedRetry() });
					const retryAction = await promptApprovalDialog(
						ctx,
						formatDialogTitle("⚖️ [重复被拦命令人工核准 (Auto Mode)]", "重复命令被拦", loopCheck),
						retryDialog,
						loopCheck.isLoop,
						true,
					);
					return handleOutcome(retryAction, dslRule, ctx, cmd, toolName, input);
				}

				let decision: { shouldBlock: boolean; reason: string; stage: "fast" | "thinking" | "fallback"; outage?: boolean };
				// ：触顶判断时点捕获（同 read 分支）
				const circuitFallbackBash = unavailableCircuitTripped();
				if (circuitFallbackBash) {
					decision = fallbackHeuristicCheck(toolName, input, ctx.cwd);
				} else {
					decision = await runTwoStageClassifier(ctx, "bash", input);
				}

				if (!decision.shouldBlock) {
					return allowCall(toolName, input);
				}

				if (!ctx.hasUI) {
					return blockCall(
						toolName,
						input,
						DENIAL_MESSAGES.autoCommandBlocked(decision.reason, cmd),
						false,
						!decision.outage,
					);
				}

				denialTracker.consumePendingFingerprint();

				const dialogDetails: Array<{ label: string; content: string }> = [];
				if (loopCheck.isLoop && loopCheck.warningMessage) {
					dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
				}
				dialogDetails.push({ label: "准备执行命令", content: cmd });
				// ：降级态标注（与 read 分支同款——非分类器结论）
				if (decision.stage === "fallback") {
					dialogDetails.push({
						label: "⚠️ 分类器无判决（降级为规则研判）",
						content: "分类器本次未能给出判决，已按启发式规则研判；人工批准一次即恢复分类器判定（连续无判决将自动熔断）。",
					});
				}
				dialogDetails.push({ label: "分类器研判风险", content: decision.reason });
				dialogDetails.push({ label: "静态结构特征", content: shellAnalysis.reason || "非安全只读命令" });

				const action = await promptApprovalDialog(
					ctx,
					formatDialogTitle("⚖️ [安全分类器风险拦截 (Auto Mode)]", "Shell 执行", loopCheck),
					dialogDetails,
					loopCheck.isLoop,
				);

				return handleOutcome(action, dslRule, ctx, cmd, toolName, input, circuitFallbackBash);
			}

			// 未知工具安全处置 (Module B: 降级态绝对禁止静默放行)
			if (unavailableCircuitTripped()) {
				const fallback = evaluateFallbackAction(toolName, input, { cwd: ctx.cwd });
				if (fallback.action === "require_approval") {
					if (!ctx.hasUI) {
						return blockCall(toolName, input, fallback.reason, false, false);
					}
					const unknownDialog: Array<{ label: string; content: string }> = [];
					if (loopCheck.isLoop && loopCheck.warningMessage) {
						unknownDialog.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
					}
					unknownDialog.push({ label: "未知工具", content: toolName });
					unknownDialog.push({ label: "调用参数", content: JSON.stringify(input) });
					unknownDialog.push({ label: "降级原因", content: fallback.reason });
					const unknownAction = await promptApprovalDialog(
						ctx,
						formatDialogTitle("⚠️ [未知工具降级审批 (Auto Mode)]", "未知工具", loopCheck),
						unknownDialog,
						loopCheck.isLoop,
					);
					return handleOutcome(unknownAction, toolName, ctx, toolName, toolName, input, true);
				}
			}

			return allowCall(toolName, input);
		}

		// 4) auto-edit 模式：文件工具放行，仅审批 bash
		if (currentMode === "auto-edit") {
			// 文件局部修改审批 (edit)
			if (toolName === "edit") {
				const filePath = (input.path || "未知文件").replace(/\\/g, "/");
				const relPath = relative(ctx.cwd, filePath).replace(/\\/g, "/");
				const dslRule = `Edit(${relPath})`;

				if (isProtectedPath(filePath) || isProtectedPath(relPath) || isEscapingWorkspace(ctx.cwd, filePath)) {
					if (!ctx.hasUI) {
						return blockCall(
							toolName,
							input,
							DENIAL_MESSAGES.autoEditProtectedPathHeadless(relPath),
						);
					}

					const editCount = Array.isArray(input.edits) ? input.edits.length : 1;
					const dialogDetails: Array<{ label: string; content: string }> = [];
					if (loopCheck.isLoop && loopCheck.warningMessage) {
						dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
					}
					dialogDetails.push({ label: "目标文件", content: relPath });
					dialogDetails.push({ label: "拦截原因", content: "受保护路径或工作区外，需要人工确认" });
					dialogDetails.push({ label: "修改详情", content: `共计 ${editCount} 处代码区块替换` });

					const action = await promptApprovalDialog(
						ctx,
						formatDialogTitle("🛡️ [边界越权修改审批 (auto-edit)]", "编辑受保护或越界文件", loopCheck),
						dialogDetails,
						loopCheck.isLoop,
					);

					return handleOutcome(action, dslRule, ctx, relPath, toolName, input);
				}
				return allowCall(toolName, input);
			}

			// 覆写文件审批 (write)
			if (toolName === "write") {
				const filePath = (input.path || input.target_file || "未知文件").replace(/\\/g, "/");
				const relPath = relative(ctx.cwd, filePath).replace(/\\/g, "/");
				const dslRule = `Edit(${relPath})`;

				if (isProtectedPath(filePath) || isProtectedPath(relPath) || isEscapingWorkspace(ctx.cwd, filePath)) {
					if (!ctx.hasUI) {
						return blockCall(
							toolName,
							input,
							DENIAL_MESSAGES.autoEditProtectedPathHeadless(relPath),
						);
					}

					const bytes = typeof input.content === "string" ? input.content.length : 0;
					const dialogDetails: Array<{ label: string; content: string }> = [];
					if (loopCheck.isLoop && loopCheck.warningMessage) {
						dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
					}
					dialogDetails.push({ label: "目标文件", content: relPath });
					dialogDetails.push({ label: "拦截原因", content: "受保护路径或工作区外，需要人工确认" });
					dialogDetails.push({ label: "写入大小", content: `${bytes} 字节` });

					const action = await promptApprovalDialog(
						ctx,
						formatDialogTitle("🛡️ [边界越权覆写审批 (auto-edit)]", "覆写受保护或越界文件", loopCheck),
						dialogDetails,
						loopCheck.isLoop,
					);

					return handleOutcome(action, dslRule, ctx, relPath, toolName, input);
				}
				return allowCall(toolName, input);
			}

			if (toolName === "bash") {
				const cmd = (input.command || "").trim();
				const dslRule = `Bash(${cmd})`;

				if (!ctx.hasUI) {
					return blockCall(
						toolName,
						input,
						DENIAL_MESSAGES.autoEditHeadless(cmd),
					);
				}

				const dialogDetails: Array<{ label: string; content: string }> = [];
				if (loopCheck.isLoop && loopCheck.warningMessage) {
					dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
				}
				dialogDetails.push({ label: "准备执行命令", content: cmd });

				const action = await promptApprovalDialog(
					ctx,
					formatDialogTitle("📝 [Shell 命令执行审批 (auto-edit)]", "Shell 命令", loopCheck),
					dialogDetails,
					loopCheck.isLoop,
				);

				return handleOutcome(action, dslRule, ctx, cmd, toolName, input);
			}

			return allowCall(toolName, input);
		}

		// 5) manual 模式：文件修改与 bash 均需审批
		if (currentMode === "manual") {
			// 文件局部修改审批 (edit)
			if (toolName === "edit") {
				const filePath = (input.path || "未知文件").replace(/\\/g, "/");
				const relPath = relative(ctx.cwd, filePath).replace(/\\/g, "/");
				const dslRule = `Edit(${relPath})`;

				if (!ctx.hasUI) {
					return blockCall(
						toolName,
						input,
						DENIAL_MESSAGES.manualEditHeadless(relPath),
					);
				}

				const editCount = Array.isArray(input.edits) ? input.edits.length : 1;
				const dialogDetails: Array<{ label: string; content: string }> = [];
				if (loopCheck.isLoop && loopCheck.warningMessage) {
					dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
				}
				dialogDetails.push({ label: "目标文件", content: relPath });
				dialogDetails.push({ label: "修改详情", content: `共计 ${editCount} 处代码区块替换` });

				const action = await promptApprovalDialog(
					ctx,
					formatDialogTitle("🛡️ [文件局部修改审批 (edit)]", "文件修改", loopCheck),
					dialogDetails,
					loopCheck.isLoop,
				);

				return handleOutcome(action, dslRule, ctx, relPath, toolName, input);
			}

			// 文件全量写入审批 (write)
			if (toolName === "write") {
				const filePath = (input.path || "未知文件").replace(/\\/g, "/");
				const relPath = relative(ctx.cwd, filePath).replace(/\\/g, "/");
				const dslRule = `Edit(${relPath})`;

				if (!ctx.hasUI) {
					return blockCall(
						toolName,
						input,
						DENIAL_MESSAGES.manualWriteHeadless(relPath),
					);
				}

				const bytes = typeof input.content === "string" ? input.content.length : 0;
				const dialogDetails: Array<{ label: string; content: string }> = [];
				if (loopCheck.isLoop && loopCheck.warningMessage) {
					dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
				}
				dialogDetails.push({ label: "目标文件", content: relPath });
				dialogDetails.push({ label: "写入大小", content: `${bytes} 字节` });

				const action = await promptApprovalDialog(
					ctx,
					formatDialogTitle("🛡️ [文件全量写入/创建审批 (write)]", "全量写入", loopCheck),
					dialogDetails,
					loopCheck.isLoop,
				);

				return handleOutcome(action, dslRule, ctx, relPath, toolName, input);
			}

			// Shell 命令执行审批 (bash)
			if (toolName === "bash") {
				const cmd = (input.command || "").trim();
				const dslRule = `Bash(${cmd})`;

				if (!ctx.hasUI) {
					return blockCall(
						toolName,
						input,
						DENIAL_MESSAGES.manualBashHeadless(cmd),
					);
				}

				const dialogDetails: Array<{ label: string; content: string }> = [];
				if (loopCheck.isLoop && loopCheck.warningMessage) {
					dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
				}
				dialogDetails.push({ label: "准备执行命令", content: cmd });

				const action = await promptApprovalDialog(
					ctx,
					formatDialogTitle("🛡️ [Shell 命令执行审批 (manual)]", "Shell 命令", loopCheck),
					dialogDetails,
					loopCheck.isLoop,
				);

				return handleOutcome(action, dslRule, ctx, cmd, toolName, input);
			}
		}

		return allowCall(toolName, input);
	});
}
