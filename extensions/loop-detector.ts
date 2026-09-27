/**
 * Loop and Stagnation Detection Circuit Breaker
 *
 * 轻量级死循环与连续失败统计熔断器（对标 Qwen Code LoopDetectionService 架构）
 *
 * 核心统计与防护维度：
 * 1. 连续同名同参死循环 (Consecutive Identical Calls):
 *    - 连续 3 次发出完全相同的 (toolName, input) 调用时触发熔断。
 * 2. 连续被拒熔断 (Consecutive Denials Streak):
 *    - 当工具调用连续被用户拒绝或权限策略拦截达 3 次时触发熔断。
 * 3. 参数颠簸停滞 (Parameter-Thrashing Stagnation):
 *    - 连续 6 次在同一工具上反复尝试且处于非成功状态时触发停滞熔断。
 *
 * 响应策略：
 * - 无头模式 (Headless / !ctx.hasUI): 直接快速失败 (Fast-Fail)，向模型返回致命熔断原因，避免后台死刷 Token；
 * - 交互式模式 (TUI): 弹出高危警示弹窗，明确告知用户模型疑似陷入死循环，提示人工介入打断。
 */

export interface ToolCallSignature {
	toolName: string;
	inputKey: string;
}

export interface LoopCheckResult {
	isLoop: boolean;
	loopType?: "identical_call_loop" | "consecutive_denials" | "action_stagnation";
	streak: number;
	warningMessage?: string;
}

export class LoopDetector {
	private lastToolName: string | null = null;
	private lastInputKey: string | null = null;

	// 1. 同名同参连续计数
	private identicalStreak = 0;
	private identicalThreshold: number;

	// 2. 连续被拒计数
	private consecutiveDenials = 0;
	private denialThreshold: number;

	// 3. 同工具连续停滞计数 (参数微调但工具相同)
	private sameToolStreak = 0;
	private stagnationThreshold: number;

	constructor(options?: {
		identicalThreshold?: number;
		denialThreshold?: number;
		stagnationThreshold?: number;
	}) {
		this.identicalThreshold = options?.identicalThreshold ?? 3;
		this.denialThreshold = options?.denialThreshold ?? 3;
		this.stagnationThreshold = options?.stagnationThreshold ?? 6;
	}

	/**
	 * 动态更新熔断阈值（支持从配置文件加载自定义阈值）
	 */
	public updateThresholds(options?: {
		identicalThreshold?: number;
		denialThreshold?: number;
		stagnationThreshold?: number;
	}): void {
		if (typeof options?.identicalThreshold === "number" && options.identicalThreshold > 0) {
			this.identicalThreshold = options.identicalThreshold;
		}
		if (typeof options?.denialThreshold === "number" && options.denialThreshold > 0) {
			this.denialThreshold = options.denialThreshold;
		}
		if (typeof options?.stagnationThreshold === "number" && options.stagnationThreshold > 0) {
			this.stagnationThreshold = options.stagnationThreshold;
		}
	}

	/**
	 * 将工具输入参数序列化为稳定的特征 Key (去除无害空白，排序 keys)
	 */
	public static createInputKey(input: Record<string, any>): string {
		try {
			const keys = Object.keys(input).sort();
			const sortedObj: Record<string, any> = {};
			for (const k of keys) {
				sortedObj[k] = input[k];
			}
			return JSON.stringify(sortedObj);
		} catch {
			return JSON.stringify(input);
		}
	}

	/**
	 * 在工具调用被实际判定前，检查是否已经触发死循环特征
	 */
	public checkBeforeExecution(toolName: string, input: Record<string, any>): LoopCheckResult {
		const currentKey = LoopDetector.createInputKey(input);

		// 检查 1: 连续完全相同的 (toolName, args)
		let nextIdenticalStreak = 1;
		if (this.lastToolName === toolName && this.lastInputKey === currentKey) {
			nextIdenticalStreak = this.identicalStreak + 1;
		}

		if (nextIdenticalStreak >= this.identicalThreshold) {
			return {
				isLoop: true,
				loopType: "identical_call_loop",
				streak: nextIdenticalStreak,
				warningMessage: `检测到模型已连续 ${nextIdenticalStreak} 次发出完全相同的工具调用 (${toolName})，可能已陷入死循环！`,
			};
		}

		// 检查 2: 连续被拒绝次数是否已触顶
		if (this.consecutiveDenials >= this.denialThreshold) {
			return {
				isLoop: true,
				loopType: "consecutive_denials",
				streak: this.consecutiveDenials,
				warningMessage: `模型发起的工具调用已连续被拒绝 ${this.consecutiveDenials} 次！检测到重试死锁，请停止重试并转换策略。`,
			};
		}

		// 检查 3: 同一工具连续停滞 (参数微调)
		let nextSameToolStreak = 1;
		if (this.lastToolName === toolName) {
			nextSameToolStreak = this.sameToolStreak + 1;
		}
		if (nextSameToolStreak >= this.stagnationThreshold) {
			return {
				isLoop: true,
				loopType: "action_stagnation",
				streak: nextSameToolStreak,
				warningMessage: `模型已连续 ${nextSameToolStreak} 次在工具 "${toolName}" 上反复尝试且无实质进展 (参数颠簸停滞)！`,
			};
		}

		return { isLoop: false, streak: 0 };
	}

	/**
	 * 记录一次成功的放行 (由用户批准或策略放行)
	 */
	public recordSuccess(toolName: string, input: Record<string, any>): void {
		const currentKey = LoopDetector.createInputKey(input);

		if (this.lastToolName === toolName && this.lastInputKey === currentKey) {
			this.identicalStreak++;
		} else {
			this.identicalStreak = 1;
		}

		if (this.lastToolName === toolName) {
			this.sameToolStreak++;
		} else {
			this.sameToolStreak = 1;
		}

		this.lastToolName = toolName;
		this.lastInputKey = currentKey;

		// 成功放行时，连续被拒绝的计数清零
		this.consecutiveDenials = 0;
	}

	/**
	 * 记录一次调用被拒绝/阻断 (无论是被用户拒绝、还是被规则阻断)
	 */
	public recordDenial(toolName: string, input: Record<string, any>): void {
		const currentKey = LoopDetector.createInputKey(input);

		if (this.lastToolName === toolName && this.lastInputKey === currentKey) {
			this.identicalStreak++;
		} else {
			this.identicalStreak = 1;
		}

		if (this.lastToolName === toolName) {
			this.sameToolStreak++;
		} else {
			this.sameToolStreak = 1;
		}

		this.lastToolName = toolName;
		this.lastInputKey = currentKey;

		// 递增连续拒绝计数
		this.consecutiveDenials++;
	}

	/**
	 * 重置所有计数器 (如切换模式或开启新会话时)
	 */
	public reset(): void {
		this.lastToolName = null;
		this.lastInputKey = null;
		this.identicalStreak = 0;
		this.consecutiveDenials = 0;
		this.sameToolStreak = 0;
	}

	public getConsecutiveDenials(): number {
		return this.consecutiveDenials;
	}
}
