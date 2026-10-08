// approval-config.ts —— 模式词汇表与配置文件加载（纯模块，零 pi 运行时依赖，可单测）
//
// 从 approval-mode.ts 抽出：ApprovalMode 类型、旧名别名归一入口（normalizeMode）、
// 配置文件格式与带信任闸的加载逻辑。agentDir 由调用方注入（运行时传 getAgentDir()，
// 单测传临时目录），项目配置目录硬编码 ".pi"（与 permission-engine 规则文件路径约定一致）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DenialLimits } from "./denial-tracker.ts";

// ==========================================
// 审批模式词汇表与旧名别名（v0.3.0: default → manual）
// ==========================================

export type ApprovalMode = "manual" | "auto-edit" | "auto" | "yolo" | "plan";

export const ALL_MODES: ApprovalMode[] = ["manual", "auto-edit", "auto", "yolo", "plan"];

/** 旧模式名别名：兼容既有配置、CLI 参数与历史会话状态。 */
const MODE_ALIAS: Record<string, ApprovalMode> = { default: "manual" };

/** 规范化模式字符串：接受旧别名，返回合法模式或 undefined（非法值交由内置默认回退）。 */
export function normalizeMode(value: unknown): ApprovalMode | undefined {
	if (typeof value !== "string") return undefined;
	const aliased = MODE_ALIAS[value] ?? value;
	return ALL_MODES.includes(aliased as ApprovalMode) ? (aliased as ApprovalMode) : undefined;
}

// ==========================================
// 配置文件格式定义 (~/.pi/agent/approval-config.json)
// ==========================================

export interface LoopDetectionConfig {
	identicalThreshold?: number; // 连续同名同参熔断阈值（默认 3）
	denialThreshold?: number; // 连续被拒熔断阈值（默认 3）
	stagnationThreshold?: number; // 参数颠簸停滞熔断阈值（默认 6）
}

// ==========================================
// 分类器思考档位词汇表 (Extended Thinking Levels)
// 取值域：off / minimal / low / medium / high / xhigh / max
// ==========================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const EXTENDED_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (EXTENDED_THINKING_LEVELS as readonly string[]).includes(value);
}

export interface ApprovalConfigFile {
	classifierModel?: string; // 审批分类器模型，例如 "llm-proxy-openai-chat/gemini-3.8-flash-high-lp"
	classifierStage1Model?: string; // 审批分类器 Stage 1 (快筛) 模型
	classifierStage2Model?: string; // 审批分类器 Stage 2 (复核) 模型
	classifierStage1Thinking?: ThinkingLevel; // Stage 1 思考档位 (off..max)
	classifierStage2Thinking?: ThinkingLevel; // Stage 2 思考档位 (off..max)
	defaultMode?: ApprovalMode; // 默认启动模式，例如 "auto" 或 "manual"（旧值 "default" 自动映射为 manual）
	classifierTimeoutMs?: number; // Stage 1 快筛超时毫秒数 (默认 1500ms)
	classifierStage2TimeoutMs?: number; // Stage 2 复核超时毫秒数 (缺省 = Stage 1 × 2)
	loopDetection?: LoopDetectionConfig; // 死循环与连续失败统计熔断阈值用户偏好配置
	denialLimits?: Partial<DenialLimits>; // 无头拦截与连续失败阈值 (对齐 Qwen Code)
	headlessAbortOnDenialCap?: boolean; // 达到累计拦截上限时是否附带 terminate: true 终止无头任务
	comment?: string;
}

export interface LoadApprovalConfigResult {
	config: ApprovalConfigFile;
	projectConfigFound: boolean;
	projectConfigBlocked: boolean;
}

/**
 * 加载配置文件（工作区 .pi/approval-config.json 需经信任闸核验后方可覆盖全局配置）。
 *
 * 信任闸为**文件粒度**：未受信任时项目级配置整份跳过（含 defaultMode 等任意键），
 * 杜绝恶意仓库经 `defaultMode: "yolo"` 静默提权。
 *
 * @param cwd        工作区根目录
 * @param isTrusted  项目是否受信任（ctx.isProjectTrusted()）
 * @param agentDir   pi agent 配置目录（运行时 getAgentDir()，单测注入临时目录）
 */
export function loadApprovalConfig(
	cwd: string,
	isTrusted: boolean,
	agentDir: string,
): LoadApprovalConfigResult {
	let config: ApprovalConfigFile = {};
	let projectConfigFound = false;
	let projectConfigBlocked = false;

	// 1. 全局配置
	const globalConfigPath = join(agentDir, "approval-config.json");
	if (existsSync(globalConfigPath)) {
		try {
			const data = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
			config = { ...config, ...data };
		} catch {
			// ignore
		}
	}

	// 2. 项目工作区配置覆盖（经信任闸核验）
	const projectConfigPath = join(cwd, ".pi", "approval-config.json");
	if (existsSync(projectConfigPath)) {
		projectConfigFound = true;
		if (isTrusted) {
			try {
				const data = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
				config = { ...config, ...data };
			} catch {
				// ignore
			}
		} else {
			projectConfigBlocked = true;
		}
	}

	return { config, projectConfigFound, projectConfigBlocked };
}
