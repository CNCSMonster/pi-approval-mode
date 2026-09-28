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
	maxConsecutiveUnavailable: number; // 连续分类器不可用阈值 (默认 2)
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
			maxConsecutiveUnavailable: options?.limits?.maxConsecutiveUnavailable ?? 2,
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
				reasonText: `Auto mode reached its session denial cap (${this.limits.maxTotalDenials}). Further flagged actions will be denied without classification; unrelated safe work may continue.`,
			};
		}

		// 2. 连续拦截上限 (consecutiveBlock >= maxConsecutiveBlock)
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
	 * 记录一次成功放行 (重置连续计数器与动作指纹，但不重置会话累计计数)
	 */
	public recordAllow(): void {
		this.consecutiveBlock = 0;
		this.consecutiveUnavailable = 0;
		this.pendingManualRetryFingerprint = null;
	}

	/**
	 * 记录分类器成功作出一次裁决 (不论 allow 还是 block，只要分类器成功响应即消除不可用计数)
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
// 2. 统一英文引导文案表 (Spec §3.5 规范)
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

	autoEditHeadless: (cmd: string): string =>
		`[Auto-edit Mode] Shell execution requires approval, but no interactive UI is available: ${cmd}. Continue with unrelated safe work or report the blocker to the user.`,

	defaultEditHeadless: (relPath: string): string =>
		`[Default Mode] File edits require approval, but no interactive UI is available: ${relPath}. Continue with unrelated safe work or report the blocker to the user.`,

	defaultWriteHeadless: (relPath: string): string =>
		`[Default Mode] File writes require approval, but no interactive UI is available: ${relPath}. Continue with unrelated safe work or report the blocker to the user.`,

	defaultBashHeadless: (cmd: string): string =>
		`[Default Mode] Shell execution requires approval, but no interactive UI is available: ${cmd}. Continue with unrelated safe work or report the blocker to the user.`,

	heuristicFallback: (matchedPattern: string): string =>
		`[Heuristic Check] Blocked by deterministic high-risk rules: ${matchedPattern}. To request manual approval, retry the same tool call without changing its arguments.`,

	classifierBlockedRetry: (): string =>
		`Auto mode previously blocked this exact action. Retry it unchanged to request manual approval, or continue with unrelated safe work.`,

	consecutiveBlock: (classifierReason: string): string =>
		`Auto mode reached its consecutive denial limit on this action (${classifierReason}). Manual approval is required before retrying.`,

	consecutiveUnavailable: (n: number): string =>
		`Auto mode could not classify consecutive actions (classifier unavailable x${n}). Falling back to heuristic checks; review risky actions manually.`,

	totalDenial: (max: number): string =>
		`Auto mode reached its session denial cap (${max}). Further flagged actions will be denied without classification; unrelated safe work may continue.`,

	singleUnavailable: (reason: string): string =>
		`Auto mode could not classify this action (${reason}). Falling back to heuristic checks. Consider switching to default mode if manual review is needed.`,
};
