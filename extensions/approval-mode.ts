/**
 * Approval Mode Extension for Pi
 *
 * 为 Pi 提供对齐千问 Code (Qwen Code) 的多级工具审批模式、权限规则体系与两阶段 LLM 安全分类器：
 *
 * 1. default   - 标准确认模式：文件修改 (edit/write) 与 Shell 命令 (bash) 执行前均需用户审批确认。
 * 2. auto-edit - 自动批准文件编辑：edit/write 自动放行，仅 Shell 命令 (bash) 需审批确认。
 * 3. auto      - 智能两阶段分类器模式（Qwen Code Auto 模式架构）：
 *                - Layer 1: 工作区常规文件修改免审（自身配置与敏感凭据除外）
 *                - Layer 2: 工业级 Shell 只读安全校验 (词法分词、操作符解析、重定向与管道守卫)
 *                - Layer 3: 【双阶段 LLM 安全分类器 (Two-Stage Classifier)】
 *                  • Stage 1 (Fast Path): ~300ms 快速研判 (带 1500ms 超时熔断)
 *                  • Stage 2 (Review Path): 仅当 Stage 1 标记可疑时触发深度推理，消除误报
 *                  • 降级容灾：若分类器离线/超时/不可用，自动平滑回退至高危规则启发式风控
 * 4. yolo      - 全自动模式：所有工具调用无条件直接执行（Pi 默认行为）。
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
 * - 四级免审作用域 (单次 / 会话 / 项目级持久化 / 用户级持久化 / 拒绝)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type AutocompleteItem } from "@earendil-works/pi-tui";

import { analyzeShellCommand } from "./shell-analyzer.ts";
import { fallbackHeuristicCheck, isProtectedPath, CLASSIFIER_BASE_PROMPT } from "./heuristic-guard.ts";
import {
	PermissionManager,
	buildReadDslRule,
	formatScopeName,
	getToolDefaultPermission,
	isReadOnlyTool,
	resolveReadDisposition,
	type DecisionType,
} from "./permission-engine.ts";
import { LoopDetector, type LoopCheckResult } from "./loop-detector.ts";
import { DenialTracker, DENIAL_MESSAGES } from "./denial-tracker.ts";
import { projectToolInput, buildTranscript } from "./classifier-projection.ts";
import {
	ALL_MODES,
	normalizeMode,
	loadApprovalConfig,
	type ApprovalMode,
	type ApprovalConfigFile,
} from "./approval-config.ts";

// 对外 API 再导出（历史习惯从 approval-mode 取这些符号）
export { ALL_MODES, normalizeMode, loadApprovalConfig };
export type { ApprovalMode, ApprovalConfigFile };

// 模式说明文案
const MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
	manual: "🛡️ manual - 人审模式（文件修改与 Shell 命令均需人工审批）",
	"auto-edit": "📝 auto-edit - 自动批准文件编辑（仅 Shell 命令需审批）",
	auto: "🤖 auto - 智能分类器模式（双阶段 LLM 自动判定意图与风险）",
	yolo: "⚡ yolo - 全自动模式（无条件直接执行所有工具）",
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



function parseClassifierJson(text: string): any {
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

export default function approvalModeExtension(pi: ExtensionAPI): void {
	let currentMode: ApprovalMode = "auto";
	let toolsBeforePlanMode: string[] | undefined;
	let customClassifierModel: string | undefined;
	let classifierTimeoutMs = 1500;

	// Qwen Code 四态权限规则管理器
	let permissionManager: PermissionManager;

	// 死循环与连续失败统计熔断器
	const loopDetector = new LoopDetector();

	// 无头拦截状态机与动作指纹短路追踪器 (Qwen Code 对齐)
	const denialTracker = new DenialTracker();

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

	// 更新 TUI 底部状态栏指示器
	function updateStatus(ctx: ExtensionContext): void {
		const theme = ctx.ui.theme;
		const badges: Record<ApprovalMode, string> = {
			manual: theme.fg("success", "🛡️ manual"),
			"auto-edit": theme.fg("accent", "📝 auto-edit"),
			auto: theme.fg("borderAccent", "🤖 auto"),
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
		if (fileConfig.classifierModel) {
			customClassifierModel = fileConfig.classifierModel;
		}
		if (typeof fileConfig.classifierTimeoutMs === "number" && fileConfig.classifierTimeoutMs > 0) {
			classifierTimeoutMs = fileConfig.classifierTimeoutMs;
		}
		if (fileConfig.loopDetection) {
			loopDetector.updateThresholds(fileConfig.loopDetection);
		}
		if (fileConfig.denialLimits || typeof fileConfig.headlessAbortOnDenialCap === "boolean") {
			denialTracker.updateConfig({
				limits: fileConfig.denialLimits,
				abortOnDenialCap: fileConfig.headlessAbortOnDenialCap,
			});
		}

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
			const resolvedModel = resolveClassifierModel(ctx, customClassifierModel, true);
			const modelLabel = resolvedModel
				? `${resolvedModel.provider}/${resolvedModel.id}`
				: "无可用模型 (安全规则兜底)";
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
		yolo: "全自动模式（无条件直接执行所有工具）",
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

	// 配置分类器模型：/classifier-model
	pi.registerCommand("classifier-model", {
		description: "查看或保存 Auto 模式下的快速分类器模型 (/classifier-model [provider/model|default])",
		handler: async (args, ctx) => {
			const resolved = resolveClassifierModel(ctx, customClassifierModel);
			const currentLabel = resolved ? `${resolved.provider}/${resolved.id}` : "未解析到可用模型";

			if (!args?.trim()) {
				ctx.ui.notify(`当前审批分类器模型: ${currentLabel}\n配置文件: ~/.pi/agent/approval-config.json`, "info");
				return;
			}

			const target = args.trim();
			if (target === "default") {
				customClassifierModel = undefined;
				saveGlobalApprovalConfig({ classifierModel: undefined });
				const resetResolved = resolveClassifierModel(ctx);
				ctx.ui.notify(`已重置为默认分类器模型: ${resetResolved?.provider}/${resetResolved?.id}`, "info");
				return;
			}

			customClassifierModel = target;
			saveGlobalApprovalConfig({ classifierModel: target });
			ctx.ui.notify(`已保存分类器模型配置 (${target}) 到 ~/.pi/agent/approval-config.json`, "info");
		},
	});

	// 4. 注册快捷键：Ctrl+Alt+A 快速循环切换模式
	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "循环切换审批模式 (Approval Mode)",
		handler: async (ctx) => {
			cycleApprovalMode(ctx);
		},
	});

	// 5. 提示词动态增强（针对 Plan 模式）
	pi.on("before_agent_start", async () => {
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

	/**
	 * 解析分类器模型
	 */
	function resolveClassifierModel(
		ctx: ExtensionContext,
		targetModelPattern?: string,
		notifyFallback = false,
	): any {
		if (targetModelPattern) {
			let found: any = null;
			if (targetModelPattern.includes("/")) {
				const [p, ...rest] = targetModelPattern.split("/");
				const id = rest.join("/");
				const candidate = ctx.modelRegistry.find(p, id);
				if (candidate && ctx.modelRegistry.hasConfiguredAuth(candidate)) {
					found = candidate;
				}
			} else {
				for (const m of ctx.modelRegistry.getAll()) {
					if (m.id === targetModelPattern && ctx.modelRegistry.hasConfiguredAuth(m)) {
						found = m;
						break;
					}
				}
			}

			if (found) {
				return found;
			}

			if (notifyFallback && ctx.hasUI) {
				ctx.ui.notify(
					`[ApprovalMode] 配置的分类器模型 "${targetModelPattern}" 未找到或未配置有效认证，已回退至默认模型。`,
					"warning",
				);
			}
		}

		// 默认优先查找 gemini-3.8-flash-high-lp
		const preferred =
			ctx.modelRegistry.find("llm-proxy-openai-chat", "gemini-3.8-flash-high-lp") ||
			ctx.modelRegistry.find("llm-proxy-openai-responses", "gemini-3.8-flash-high-lp") ||
			ctx.modelRegistry.find("llm-proxy-anthropic", "gemini-3.8-flash-high-lp");

		if (preferred && ctx.modelRegistry.hasConfiguredAuth(preferred)) {
			return preferred;
		}

		for (const m of ctx.modelRegistry.getAll()) {
			if (m.id === "gemini-3.8-flash-high-lp" && ctx.modelRegistry.hasConfiguredAuth(m)) {
				return m;
			}
		}

		// 安全策略：如果未配置专门分类器且当前模型为主模型，在非轻量场景避免无节制开销
		return ctx.model;
	}

	/**
	 * 离线/降级安全兜底规则校验 (启发式风控)
	 */


	/**
	 * 【双阶段 LLM 安全分类器 (Two-Stage Classifier)】
	 * Stage 1 (Fast Path): 带超时熔断控制 (默认 1500ms)
	 * Stage 2 (Review Path): 仅在 Stage 1 拦截时唤起思维链，消除误报并生成 reason
	 */
	async function runTwoStageClassifier(
		ctx: ExtensionContext,
		toolName: string,
		toolInput: Record<string, any>,
	): Promise<{ shouldBlock: boolean; reason: string; stage: "fast" | "thinking" | "fallback" }> {
		const classifierModel = resolveClassifierModel(ctx, customClassifierModel);

		// 若无可用模型，降级为确定性规则兜底
		if (!classifierModel || !ctx.modelRegistry.hasConfiguredAuth(classifierModel)) {
			denialTracker.recordUnavailable();
			const fallback = fallbackHeuristicCheck(toolName, toolInput);
			return {
				...fallback,
				reason: fallback.reason || DENIAL_MESSAGES.singleUnavailable("unconfigured"),
			};
		}

		const transcript = getRecentConversationTranscript(ctx);
		const projectedInput = projectToolInput(toolName, toolInput, ctx.cwd);
		const promptContent =
			`Conversation Transcript:\n${transcript}\n\n` +
			`## Pending tool call to classify\n\n` +
			`Tool: ${toolName}\nArguments:\n${JSON.stringify(projectedInput, null, 2)}`;

		// === Stage 1: 极速初筛 (带超时熔断保护) ===
		let stage1Response: any = null;
		try {
			const stage1Promise = ctx.modelRegistry.complete(
				classifierModel,
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
				{
					cacheRetention: "none",
				},
			);

			stage1Response = await withTimeout(stage1Promise, classifierTimeoutMs, null);
		} catch (err) {
			denialTracker.recordUnavailable();
			const fallback = fallbackHeuristicCheck(toolName, toolInput);
			return {
				...fallback,
				reason: fallback.reason || DENIAL_MESSAGES.singleUnavailable("stage1_exception"),
			};
		}

		if (!stage1Response) {
			denialTracker.recordUnavailable();
			const fallback = fallbackHeuristicCheck(toolName, toolInput);
			return {
				...fallback,
				reason: fallback.reason || DENIAL_MESSAGES.singleUnavailable(`stage1_timeout(${classifierTimeoutMs}ms)`),
			};
		}

		const stage1Text = stage1Response.content
			.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");

		const stage1Json = parseClassifierJson(stage1Text);
		if (stage1Json && stage1Json.shouldBlock === false) {
			denialTracker.recordClassifierActive();
			return { shouldBlock: false, reason: "", stage: "fast" };
		}

		// === Stage 2: 深度推理复核 (带超时熔断保护) ===
		let stage2Response: any = null;
		try {
			const stage2Promise = ctx.modelRegistry.complete(
				classifierModel,
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
				{
					cacheRetention: "none",
				},
			);

			stage2Response = await withTimeout(stage2Promise, classifierTimeoutMs * 2, null);
		} catch (err) {
			denialTracker.recordUnavailable();
			const fallback = fallbackHeuristicCheck(toolName, toolInput);
			return {
				...fallback,
				reason: fallback.reason || DENIAL_MESSAGES.singleUnavailable("stage2_exception"),
			};
		}

		if (!stage2Response) {
			denialTracker.recordUnavailable();
			const fallback = fallbackHeuristicCheck(toolName, toolInput);
			return {
				...fallback,
				reason: fallback.reason || DENIAL_MESSAGES.singleUnavailable(`stage2_timeout(${classifierTimeoutMs * 2}ms)`),
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
		const fallback = fallbackHeuristicCheck(toolName, toolInput);
		return {
			...fallback,
			reason: fallback.reason || DENIAL_MESSAGES.singleUnavailable("json_parse_fail"),
		};
	}

	/**
	 * 弹出支持数字快捷键单键直选的审批面板 (Custom TUI Dialog)
	 */
	async function promptApprovalDialog(
		ctx: ExtensionContext,
		title: string,
		details: Array<{ label: string; content: string }>,
		isLoop = false,
	): Promise<ApprovalAction> {
		const options: ApprovalOption[] = isLoop ? [...APPROVAL_OPTIONS, LOOP_ABORT_OPTION] : APPROVAL_OPTIONS;

		if (ctx.mode === "tui") {
			const result = await ctx.ui.custom<ApprovalAction | null>((tui, theme, _kb, done) => {
				let selectedIndex = 0;

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

						const addLine = (str: string) => {
							lines.push(truncateToWidth(str, safeWidth));
						};

						// 顶部线条与标题
						addLine(theme.fg("accent", "─".repeat(safeWidth)));
						addLine(` ${theme.fg("accent", theme.bold(title))}`);
						addLine(` ${theme.fg("accent", `当前审批模式: ${currentMode}  (按 Ctrl+Alt+A 可切换)`)}`);
						addLine("");

						// 详细信息展示区
						for (const item of details) {
							addLine(`  ${theme.fg("muted", item.label)}:`);
							for (const cl of item.content.split("\n")) {
								addLine(`    ${theme.fg("text", cl)}`);
							}
						}

						addLine("");
						addLine(theme.fg("muted", `  请选择审批动作 (支持直接按数字键 1-${options.length} 快速选择):`));
						addLine("");

						// 渲染编号选项
						for (let i = 0; i < options.length; i++) {
							const opt = options[i];
							const isSelected = i === selectedIndex;
							const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
							const numTag = theme.fg(isSelected ? "accent" : "muted", `${i + 1}. `);
							const labelText = theme.fg(isSelected ? "accent" : "text", opt.label);

							addLine(`${prefix}${numTag}${labelText}`);
							if (opt.description) {
								addLine(`     ${theme.fg("dim", opt.description)}`);
							}
						}

						addLine("");
						addLine(theme.fg("muted", `  [快捷提示] 按 1-${options.length} 直接选择 | ↑/↓ 移动 | Enter 确认 | Esc 拒绝 | Ctrl+Alt+A 切换模式`));
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
			const promptBody = `${title}\n\n${details.map((d) => `${d.label}:\n  ${d.content}`).join("\n")}`;
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

	function blockCall(
		toolName: string,
		input: Record<string, any>,
		reason: string,
		terminate = false,
	): ToolCallEventResult {
		loopDetector.recordDenial(toolName, input);
		const fingerprint = DenialTracker.createFingerprint(toolName, input);
		denialTracker.recordBlock(fingerprint);
		const res: ToolCallEventResult = { block: true, reason };
		if (terminate) {
			(res as any).terminate = true;
		}
		return res;
	}

	/**
	 * 处理用户的审批选择并持久化为标准 Qwen Code DSL 规则
	 */
	async function handleOutcome(
		action: ApprovalAction,
		dslRule: string,
		ctx: ExtensionContext,
		label: string,
		toolName: string,
		input: Record<string, any>,
	): Promise<ToolCallEventResult | undefined> {
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
				return blockCall(
					toolName,
					input,
					`[User Directive] The user explicitly rejected this action and commanded you to halt this direction immediately. Reflect on the blocker, step back, and pursue a completely different approach.`,
				);

			case "block":
			default:
				return blockCall(toolName, input, DENIAL_MESSAGES.userDenied(label));
		}
	}

	// 6. 核心门禁控制：拦截 tool_call
	pi.on("tool_call", async (event, ctx) => {
		const { toolName } = event;
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
			// 硬上限触发：即使在交互模式下也直接强行熔断，不再弹窗骚扰用户
			if (loopCheck.isHardLimit) {
				ctx.ui.notify(loopCheck.warningMessage || "死循环已达硬上限，已强制熔断！", "error");
				return blockCall(
					toolName,
					input,
					DENIAL_MESSAGES.circuitBreaker(loopCheck.warningMessage || "Hard limit reached"),
				);
			}

			// 在无头模式 (Headless / !ctx.hasUI) 下：直接快速失败，强制阻断死循环！
			if (!ctx.hasUI) {
				return blockCall(
					toolName,
					input,
					DENIAL_MESSAGES.circuitBreaker(loopCheck.warningMessage || "Loop detected"),
				);
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
			return blockCall(
				toolName,
				input,
				DENIAL_MESSAGES.presetDeny(permDecision.matchedRule || ""),
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
				const filePath = (input.path || "").replace(/\\/g, "/");
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
			const toolDefault = getToolDefaultPermission(toolName, targetPath, ctx.cwd);

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
					return blockCall(toolName, input, fallback.reasonText || "Blocked", terminate);
				}

				let decision: { shouldBlock: boolean; reason: string; stage: "fast" | "thinking" | "fallback" };
				if (fallback.shouldFallback && fallback.kind === "consecutive_unavailable") {
					decision = fallbackHeuristicCheck(toolName, input);
				} else {
					decision = await runTwoStageClassifier(ctx, toolName, input);
				}

				if (!decision.shouldBlock) {
					return allowCall(toolName, input);
				}

				if (!ctx.hasUI) {
					return blockCall(toolName, input, DENIAL_MESSAGES.autoReadBlocked(decision.reason, label));
				}

				denialTracker.consumePendingFingerprint();

				const classifierDialog: Array<{ label: string; content: string }> = [];
				if (loopCheck.isLoop && loopCheck.warningMessage) {
					classifierDialog.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
				}
				classifierDialog.push({ label: "读取目标", content: label });
				classifierDialog.push({ label: "分类器研判风险", content: decision.reason });

				const classifierAction = await promptApprovalDialog(
					ctx,
					formatDialogTitle("🤖 [读取安全分类器研判 (Auto Mode)]", "读取风险", loopCheck),
					classifierDialog,
					loopCheck.isLoop,
				);

				return handleOutcome(classifierAction, dslRule, ctx, label, toolName, input);
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

		// 1) yolo 模式：无条件直接放行
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
				const filePath = (input.path || "").replace(/\\/g, "/");
				const relPath = relative(ctx.cwd, filePath).replace(/\\/g, "/");
				const dslRule = `Edit(${relPath})`;

				// 若修改的是受保护的核心配置或系统敏感文件，转入分类器研判
				if (isProtectedPath(filePath) || isProtectedPath(relPath) || relPath.startsWith("..")) {
					const fingerprint = DenialTracker.createFingerprint(toolName, input);
					const fallback = denialTracker.checkFallback(fingerprint);
					if (fallback.shouldFallback && !ctx.hasUI) {
						const terminate = fallback.kind === "total_denial" && denialTracker.shouldAbortOnCap();
						return blockCall(toolName, input, fallback.reasonText || "Blocked", terminate);
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
						);
					}

					denialTracker.consumePendingFingerprint();

					const dialogDetails: Array<{ label: string; content: string }> = [];
					if (loopCheck.isLoop && loopCheck.warningMessage) {
						dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
					}
					dialogDetails.push({ label: "目标文件", content: relPath });
					dialogDetails.push({ label: "拦截原因", content: decision.reason });

					const action = await promptApprovalDialog(
						ctx,
						formatDialogTitle("🤖 [受保护敏感路径修改审批 (Auto Mode)]", "敏感路径修改", loopCheck),
						dialogDetails,
						loopCheck.isLoop,
					);

					return handleOutcome(action, dslRule, ctx, relPath, toolName, input);
				}

				// 常规工作区内部文件编辑/写入：快路径自动放行！
				return allowCall(toolName, input);
			}

			// Shell 命令处理 (Layer 2 & Layer 3)
			if (toolName === "bash") {
				const cmd = (input.command || "").trim();
				const dslRule = `Bash(${cmd})`;

				// Layer 2: 工业级 Shell 状态机只读检测（彻底防御重定向、管道、复合注入）
				const shellAnalysis = analyzeShellCommand(cmd);
				if (shellAnalysis.isReadOnly) {
					return allowCall(toolName, input);
				}

				// Layer 3: 双阶段 LLM 安全分类器研判
				const fingerprint = DenialTracker.createFingerprint(toolName, input);
				const fallback = denialTracker.checkFallback(fingerprint);
				if (fallback.shouldFallback && !ctx.hasUI) {
					const terminate = fallback.kind === "total_denial" && denialTracker.shouldAbortOnCap();
					return blockCall(toolName, input, fallback.reasonText || "Blocked", terminate);
				}

				let decision: { shouldBlock: boolean; reason: string; stage: "fast" | "thinking" | "fallback" };
				if (fallback.shouldFallback && fallback.kind === "consecutive_unavailable") {
					decision = fallbackHeuristicCheck(toolName, input);
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
					);
				}

				denialTracker.consumePendingFingerprint();

				const dialogDetails: Array<{ label: string; content: string }> = [];
				if (loopCheck.isLoop && loopCheck.warningMessage) {
					dialogDetails.push({ label: "🚨 死循环预警", content: loopCheck.warningMessage });
				}
				dialogDetails.push({ label: "准备执行命令", content: cmd });
				dialogDetails.push({ label: "分类器研判风险", content: decision.reason });
				dialogDetails.push({ label: "静态结构特征", content: shellAnalysis.reason || "非安全只读命令" });

				const action = await promptApprovalDialog(
					ctx,
					formatDialogTitle("🤖 [安全分类器风险拦截 (Auto Mode)]", "Shell 执行", loopCheck),
					dialogDetails,
					loopCheck.isLoop,
				);

				return handleOutcome(action, dslRule, ctx, cmd, toolName, input);
			}

			return allowCall(toolName, input);
		}

		// 4) auto-edit 模式：文件工具放行，仅审批 bash
		if (currentMode === "auto-edit") {
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
