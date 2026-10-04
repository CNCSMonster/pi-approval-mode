/**
 * Denial Tracker and Headless Fallback State Machine
 *
 * 对齐 Qwen Code (0.24.0) 的无头拦截状态机与动作指纹短路防御
 * 包含三维计数防护 (consecutiveBlock / consecutiveUnavailable / totalDenials)
 * 与 pendingManualRetryFingerprint 动作指纹短路
 */

import { LoopDetector } from "./loop-detector.ts";

export interface DenialLimits {
	maxConsecutiveBlock: number; // 连续拦截阈值 (默认 3)
	maxConsecutiveUnavailable: number; // 连续分类器不可用阈值 (默认 3，对齐设计基线 M11)
	maxTotalDenials: number; // 会话累计拦截上限 (默认 20)
}

export type FallbackKind =
	| "none"
	| "total_denial"
	| "consecutive_block"
	| "consecutive_unavailable"
	| "classifier_blocked_retry";

export interface FallbackDecision {
	shouldFallback: boolean;
	kind: FallbackKind;
	reasonText?: string;
}

export class DenialTracker {
	private consecutiveBlock = 0;
	private consecutiveUnavailable = 0;
	private totalBlock = 0;
	private totalUnavailable = 0;

	private pendingManualRetryFingerprint: string | null = null;
	private limits: DenialLimits;
	private abortOnDenialCap: boolean;

	constructor(options?: {
		limits?: Partial<DenialLimits>;
		abortOnDenialCap?: boolean;
	}) {
		this.limits = {
			maxConsecutiveBlock: options?.limits?.maxConsecutiveBlock ?? 3,
			maxConsecutiveUnavailable: options?.limits?.maxConsecutiveUnavailable ?? 3,
			maxTotalDenials: options?.limits?.maxTotalDenials ?? 20,
		};
		this.abortOnDenialCap = options?.abortOnDenialCap ?? false;
	}

	public updateConfig(options?: {
		limits?: Partial<DenialLimits>;
		abortOnDenialCap?: boolean;
	}): void {
		if (options?.limits) {
			if (typeof options.limits.maxConsecutiveBlock === "number" && options.limits.maxConsecutiveBlock > 0) {
				this.limits.maxConsecutiveBlock = options.limits.maxConsecutiveBlock;
			}
			if (
				typeof options.limits.maxConsecutiveUnavailable === "number" &&
				options.limits.maxConsecutiveUnavailable > 0
			) {
				this.limits.maxConsecutiveUnavailable = options.limits.maxConsecutiveUnavailable;
			}
			if (typeof options.limits.maxTotalDenials === "number" && options.limits.maxTotalDenials > 0) {
				this.limits.maxTotalDenials = options.limits.maxTotalDenials;
			}
		}
		if (typeof options?.abortOnDenialCap === "boolean") {
			this.abortOnDenialCap = options.abortOnDenialCap;
		}
	}

	public getLimits(): DenialLimits {
		return { ...this.limits };
	}

	public shouldAbortOnCap(): boolean {
		return this.abortOnDenialCap;
	}

	public getStats(): {
		consecutiveBlock: number;
		consecutiveUnavailable: number;
		totalBlock: number;
		totalUnavailable: number;
		pendingFingerprint: string | null;
	} {
		return {
			consecutiveBlock: this.consecutiveBlock,
			consecutiveUnavailable: this.consecutiveUnavailable,
			totalBlock: this.totalBlock,
			totalUnavailable: this.totalUnavailable,
			pendingFingerprint: this.pendingManualRetryFingerprint,
		};
	}

	/**
	 * 计算动作指纹 (toolName + 规范化 input 字符串)
	 */
	public static createFingerprint(toolName: string, input: Record<string, any>): string {
		return `${toolName}:${LoopDetector.createInputKey(input)}`;
	}

	/**
	 * 检查当前动作是否命中降级与指纹短路 (判定顺序与 Qwen Code 严格一致)
	 */
	public checkFallback(fingerprint: string): FallbackDecision {
		// 1. 会话累计上限 (totalBlock + totalUnavailable >= maxTotalDenials)
		if (this.totalBlock + this.totalUnavailable >= this.limits.maxTotalDenials) {
			return {
				shouldFallback: true,
				kind: "total_denial",
				// 不向模型承诺 "unrelated safe work may continue"——无头语境下该承诺
				// 被 loop 先手的会话级熔断否决；交互语境达顶同样直接拒绝（0027-C-1）。
				// 文案只说实话并告知人如何解除（allow 规则 / 重启会话）。
				reasonText: `Auto mode reached its session denial cap (${this.limits.maxTotalDenials}). Further flagged actions will be denied without classification. This cannot be cleared from the model side: a human must add an explicit allow rule (or restart the session) to resume flagged work.`,
			};
		}

		// 2. 连续拦截上限 (consecutiveBlock >= maxConsecutiveBlock)
		//
		// 顺序事实：无头下本分支永远被 loop 检测器先手挤断——
		// loop 检查在 tool_call 的 step -1 早于一切（approval-mode.ts 步骤 -1），
		// 且 loop denialThreshold 与本处 maxConsecutiveBlock 同事件源（blockCall 的
		// recordDenial + recordBlock 锁步灌入）、同阈值（默认 3），故第 4 次连拒
		// 必然先命中 loop 的 consecutive_denials 熔断，本 kind 只在交互侧（loop
		// 不拦截、弹窗继续）或阈值被配置分叉时才可达。
		// 交互侧暂不消费本 kind。
		if (this.consecutiveBlock >= this.limits.maxConsecutiveBlock) {
			return {
				shouldFallback: true,
				kind: "consecutive_block",
				reasonText: `Auto mode reached its consecutive denial limit on this action. Manual approval is required before retrying.`,
			};
		}

		// 3. 连续不可用上限 (consecutiveUnavailable >= maxConsecutiveUnavailable)
		if (this.consecutiveUnavailable >= this.limits.maxConsecutiveUnavailable) {
			return {
				shouldFallback: true,
				kind: "consecutive_unavailable",
				reasonText: `Auto mode could not classify consecutive actions (classifier unavailable x${this.consecutiveUnavailable}). Falling back to heuristic checks; review risky actions manually.`,
			};
		}

		// 4. 动作指纹短路 (同操作被拦后未作任何修改原样重试)
		if (this.pendingManualRetryFingerprint && fingerprint === this.pendingManualRetryFingerprint) {
			return {
				shouldFallback: true,
				kind: "classifier_blocked_retry",
				reasonText: `Auto mode previously blocked this exact action. Retry it unchanged to request manual approval, or continue with unrelated safe work.`,
			};
		}

		return {
			shouldFallback: false,
			kind: "none",
		};
	}

	/**
	 * 记录一次安全拦截 (增加 consecutiveBlock, totalBlock 并更新动作指纹)
	 */
	public recordBlock(fingerprint: string): void {
		this.consecutiveBlock++;
		this.totalBlock++;
		this.pendingManualRetryFingerprint = fingerprint;
	}

	/**
	 * 记录分类器不可用/降级兜底
	 */
	public recordUnavailable(): void {
		this.consecutiveUnavailable++;
		this.totalUnavailable++;
	}

	/**
	 * （Qwen Code denialTracking.ts recordFallbackApprove 同款语义）：
	 * 降级/熔断期间用户在人工弹窗上批准任意一次 → 清两类连击计数 →
	 * 下次判定重新交分类器；若分类器仍故障则再次失败重新计数（同一恢复曲线，
	 * 无永久锁死）。拒绝路径不调用本方法（拒绝视为分类器判对，计数保持）。
	 * 快路径/规则放行仍不调用（0027-A 防洗白语义不变）。
	 */
	public recordFallbackApprove(): void {
		this.consecutiveBlock = 0;
		this.consecutiveUnavailable = 0;
	}

	/**
	 * 记录一次成功放行 (重置拒绝侧连续计数与动作指纹)
	 *
	 * consecutiveUnavailable 不在此重置——快路径放行（区内 edit、
	 * 只读 bash、规则 allow）根本没碰分类器，无权治愈"分类器连续不可用"故障计数。
	 * u 的重置入口：recordClassifierActive()（分类器成功）、recordFallbackApprove()
	 * （降级态人工批准，）与 resetAll()。
	 */
	public recordAllow(): void {
		this.consecutiveBlock = 0;
		this.pendingManualRetryFingerprint = null;
	}

	/**
	 * 记录分类器成功作出一次裁决 (不论 allow 还是 block，只要分类器成功响应即消除不可用计数)
	 *
	 * 这是 recordAllow 之外唯一可重置 consecutiveUnavailable 的入口。
	 */
	public recordClassifierActive(): void {
		this.consecutiveUnavailable = 0;
	}

	/**
	 * 人工弹窗确认交互后消费指纹
	 */
	public consumePendingFingerprint(): void {
		this.pendingManualRetryFingerprint = null;
	}

	/**
	 * 会话重置 (清除全部计数)
	 */
	public resetAll(): void {
		this.consecutiveBlock = 0;
		this.consecutiveUnavailable = 0;
		this.totalBlock = 0;
		this.totalUnavailable = 0;
		this.pendingManualRetryFingerprint = null;
	}
}

// ==============================================================
// 2. 统一英文引导文案表 
// ==============================================================

export const DENIAL_MESSAGES = {
	userDenied: (label: string): string =>
		`Blocked: the user denied "${label}".`,

	circuitBreaker: (warning: string): string =>
		`[Circuit Breaker] ${warning} Headless fast-fail: do not retry this action. Continue with unrelated safe work or report the blocker to the user.`,

	presetDeny: (rule: string): string =>
		`[Permission: deny] Blocked by preset rule ${rule}. This rule is absolute; do not attempt this action via another tool or path.`,

	presetAskHeadless: (rule: string): string =>
		`[Permission: ask] Rule ${rule} requires interactive confirmation, which is unavailable in non-interactive mode. Continue with unrelated safe work or report the blocker to the user.`,

	planModeToolDisabled: (tool: string): string =>
		`Plan mode is read-only: the "${tool}" tool is disabled. Analyze and plan only; ask the user to switch modes to make changes.`,

	planModeCommandBlocked: (cmd: string, reason: string): string =>
		`Plan mode is read-only: non-read-only command blocked: "${cmd}" (${reason}). Use read-only commands or ask the user to switch modes.`,

	autoProtectedPath: (classifierReason: string, relPath: string): string =>
		`[Auto Mode] Protected-path write blocked: ${classifierReason} (target: ${relPath}). To request manual approval, retry the same tool call without changing its arguments. You may continue with unrelated safe work or a genuinely safer alternative that does not accomplish the denied action. Do not bypass via another tool, shell indirection, generated script, alias, symlink, config change, hook, or encoded payload.`,

	autoCommandBlocked: (classifierReason: string, cmd: string): string =>
		`[Auto Mode] Command blocked by the safety classifier: ${classifierReason} (${cmd}). To request manual approval, retry the same tool call without changing its arguments. You may continue with unrelated safe work or a genuinely safer alternative. Do not bypass via another tool, shell indirection, generated script, alias, symlink, config change, hook, or encoded payload.`,

	autoReadBlocked: (classifierReason: string, targetPath: string): string =>
		`[Auto Mode] Read blocked by the safety classifier: ${classifierReason} (target: ${targetPath}). To request manual approval, retry the same tool call without changing its arguments. You may continue with unrelated safe work or a genuinely safer alternative. Do not bypass via another tool, shell indirection, generated script, alias, symlink, config change, hook, or encoded payload.`,

	autoEditReadHeadless: (targetPath: string): string =>
		`[Auto-edit Mode] Read requires approval, but no interactive UI is available: ${targetPath}. Continue with unrelated safe work or report the blocker to the user.`,

	manualReadHeadless: (targetPath: string): string =>
		`[Manual Mode] Read requires approval, but no interactive UI is available: ${targetPath}. Continue with unrelated safe work or report the blocker to the user.`,

	autoEditHeadless: (cmd: string): string =>
		`[Auto-edit Mode] Shell execution requires approval, but no interactive UI is available: ${cmd}. Continue with unrelated safe work or report the blocker to the user.`,

	autoEditProtectedPathHeadless: (relPath: string): string =>
		`[Auto-edit Mode] Protected-path or out-of-workspace edit requires approval, but no interactive UI is available: ${relPath}. Continue with unrelated safe work or report the blocker to the user.`,

	manualEditHeadless: (relPath: string): string =>
		`[Manual Mode] File edits require approval, but no interactive UI is available: ${relPath}. Continue with unrelated safe work or report the blocker to the user.`,

	manualWriteHeadless: (relPath: string): string =>
		`[Manual Mode] File writes require approval, but no interactive UI is available: ${relPath}. Continue with unrelated safe work or report the blocker to the user.`,

	manualBashHeadless: (cmd: string): string =>
		`[Manual Mode] Shell execution requires approval, but no interactive UI is available: ${cmd}. Continue with unrelated safe work or report the blocker to the user.`,

	heuristicFallback: (matchedPattern: string): string =>
		`[Heuristic Check] Blocked by deterministic high-risk rules: ${matchedPattern}. To request manual approval, retry the same tool call without changing its arguments.`,

	classifierBlockedRetry: (): string =>
		`Auto mode previously blocked this exact action. Retry it unchanged to request manual approval, or continue with unrelated safe work.`,

	consecutiveBlock: (classifierReason: string): string =>
		`Auto mode reached its consecutive denial limit on this action (${classifierReason}). Manual approval is required before retrying.`,

	consecutiveUnavailable: (n: number): string =>
		`Auto mode could not classify consecutive actions (classifier unavailable x${n}). Falling back to heuristic checks; review risky actions manually.`,

	totalDenial: (max: number): string =>
		`Auto mode reached its session denial cap (${max}). Further flagged actions will be denied without classification. This cannot be cleared from the model side: a human must add an explicit allow rule (or restart the session) to resume flagged work.`,

	headlessCircuitFused: (loopType: string, streak: number): string =>
		`[Circuit Breaker] Headless session circuit is open (${loopType}: ${streak} consecutive blocked attempts). Every further tool call in this session is now denied without classification — there is no model-side path to continue, and retrying only adds to the denial count. Human intervention is required: re-approve the action in an interactive session, or restart with an explicit allow rule. Do not retry.`,

	singleUnavailable: (reason: string): string =>
		`Auto mode could not classify this action (${reason}). Falling back to heuristic checks. Consider switching to default mode if manual review is needed.`,

	classifierContentFilter: (toolName: string): string =>
		`Classifier request was rejected by the upstream content filter — this is NOT a verdict on the action. Falling back for human review of ${toolName}; approving once restores classifier verdicts.`,

	classifierUpstreamError: (code: string, toolName: string): string =>
		`Classifier request failed upstream (${code}) — this is NOT a verdict on the action. Falling back for human review of ${toolName}; approving once restores classifier verdicts.`,
};
