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
 * 3. 同一操作停滞 (Same-Operation Stagnation):
 *    - 连续 6 次重复同一 (工具, 参数) 且处于非成功状态时触发停滞熔断；参数变化或成功即清零，
 *      因此同一工具的不同用法（如 cat file1 → file2）属于正常推进，不会误判。
 *    - **默认配置下不可达，属配置空间防护**：检查 1/2/3 顺序固定，而停滞计数与同名同参计数由同一次
 *      `recordDenial` 锁步递增、连续拒绝计数同步增长，因此停滞分支只有在两道前置检查都不先撞线时才可达，
 *      完整条件为 `identicalThreshold > stagnationThreshold` **且** `denialThreshold > stagnationThreshold`
 *      （默认 3/3/6 由 identical_call_loop 或 consecutive_denials 先手）。调整检查顺序前请先读检查 3 处的说明。
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
	isHardLimit?: boolean;
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

	// 3. 同一操作反复重试停滞计数 (同工具 + 同参数，参数变化或成功即清零)
	private sameToolStreak = 0;
	private stagnationThreshold: number;

	// 4. 超限硬熔断乘数 (默认 3 倍阈值自动硬熔断)
	private hardLimitMultiplier: number;

	constructor(options?: {
		identicalThreshold?: number;
		denialThreshold?: number;
		stagnationThreshold?: number;
		hardLimitMultiplier?: number;
	}) {
		this.identicalThreshold = options?.identicalThreshold ?? 3;
		this.denialThreshold = options?.denialThreshold ?? 3;
		this.stagnationThreshold = options?.stagnationThreshold ?? 6;
		this.hardLimitMultiplier = options?.hardLimitMultiplier ?? 3;
	}

	/**
	 * 动态更新熔断阈值（支持从配置文件加载自定义阈值）
	 */
	public updateThresholds(options?: {
		identicalThreshold?: number;
		denialThreshold?: number;
		stagnationThreshold?: number;
		hardLimitMultiplier?: number;
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
		if (typeof options?.hardLimitMultiplier === "number" && options.hardLimitMultiplier > 0) {
			this.hardLimitMultiplier = options.hardLimitMultiplier;
		}
	}

	/**
	 * 重置并动态更新熔断阈值（支持从配置文件加载自定义阈值，缺省字段回退默认基线值 3/3/6/3）
	 */
	public resetThresholds(options?: {
		identicalThreshold?: number;
		denialThreshold?: number;
		stagnationThreshold?: number;
		hardLimitMultiplier?: number;
	}): void {
		this.identicalThreshold =
			typeof options?.identicalThreshold === "number" && options.identicalThreshold > 0
				? options.identicalThreshold
				: 3;
		this.denialThreshold =
			typeof options?.denialThreshold === "number" && options.denialThreshold > 0
				? options.denialThreshold
				: 3;
		this.stagnationThreshold =
			typeof options?.stagnationThreshold === "number" && options.stagnationThreshold > 0
				? options.stagnationThreshold
				: 6;
		this.hardLimitMultiplier =
			typeof options?.hardLimitMultiplier === "number" && options.hardLimitMultiplier > 0
				? options.hardLimitMultiplier
				: 3;
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
			const hardLimit = this.identicalThreshold * this.hardLimitMultiplier;
			const isHardLimit = nextIdenticalStreak >= hardLimit;
			const warningMessage = isHardLimit
				? `【死循环硬上限触发】模型已连续 ${nextIdenticalStreak} 次发出完全相同的调用 (${toolName})，超过安全硬上限 (${hardLimit})！已强制自动熔断。`
				: nextIdenticalStreak > this.identicalThreshold
					? `🔥【严重预警】模型已连续第 ${nextIdenticalStreak} 次发出完全相同的调用 (${toolName})！检测到持续停滞，建议选择"拒绝并指示停止"；达到 ${hardLimit} 次将自动熔断。`
					: `检测到模型已连续 ${nextIdenticalStreak} 次发出完全相同的工具调用 (${toolName})，可能已陷入死循环！`;

			return {
				isLoop: true,
				isHardLimit,
				loopType: "identical_call_loop",
				streak: nextIdenticalStreak,
				warningMessage,
			};
		}

		// 检查 2: 连续被拒绝次数是否已触顶
		if (this.consecutiveDenials >= this.denialThreshold) {
			const hardLimit = this.denialThreshold * this.hardLimitMultiplier;
			const isHardLimit = this.consecutiveDenials >= hardLimit;
			const warningMessage = isHardLimit
				? `【连续被拒硬上限触发】工具调用已连续被拒绝 ${this.consecutiveDenials} 次，超过安全硬上限 (${hardLimit})！已强制自动熔断。`
				: this.consecutiveDenials > this.denialThreshold
					? `🔥【严重预警】工具调用已连续被拒绝第 ${this.consecutiveDenials} 次！检测到重试死锁，建议选择"拒绝并指示停止"；达到 ${hardLimit} 次将自动熔断。`
					: `模型发起的工具调用已连续被拒绝 ${this.consecutiveDenials} 次！检测到重试死锁，请停止重试并转换策略。`;

			return {
				isLoop: true,
				isHardLimit,
				loopType: "consecutive_denials",
				streak: this.consecutiveDenials,
				warningMessage,
			};
		}

		// 检查 3: 同一操作反复重试且无进展 (同工具 + 同参数；参数变化或成功即视为推进，不计停滞)
		//
		// 可达性（默认配置下不可达，属配置空间防护）：本分支要求检查 1 与检查 2 都不先撞线，
		// 完整前置条件为 `identicalThreshold > stagnationThreshold` 且 `denialThreshold > stagnationThreshold`。
		// 原因是三者同签名锁步递增：同签名连续拒绝 N 次时 identicalStreak 与 sameToolStreak 同为 N，
		// consecutiveDenials 亦为 N，于是检查 1（nextIdenticalStreak ≥ identicalThreshold）或检查 2
		// （consecutiveDenials ≥ denialThreshold）必在检查 3（nextSameToolStreak ≥ stagnationThreshold）之前返回。
		// 默认 3/3/6 即由 identical_call_loop / consecutive_denials 先手。检查顺序与 qwen 对齐语义保持不变。
		let nextSameToolStreak = 1;
		if (this.lastToolName === toolName && this.lastInputKey === currentKey) {
			nextSameToolStreak = this.sameToolStreak + 1;
		}
		if (nextSameToolStreak >= this.stagnationThreshold) {
			const hardLimit = this.stagnationThreshold * this.hardLimitMultiplier;
			const isHardLimit = nextSameToolStreak >= hardLimit;
			const warningMessage = isHardLimit
				? `【停滞硬上限触发】模型已连续 ${nextSameToolStreak} 次重复同一操作 (${toolName}) 且无进展，超过安全硬上限 (${hardLimit})！已强制自动熔断。`
				: nextSameToolStreak > this.stagnationThreshold
					? `🔥【严重预警】模型已连续第 ${nextSameToolStreak} 次重复同一操作 (${toolName}) 且无进展！建议选择"拒绝并指示停止"；达到 ${hardLimit} 次将自动熔断。`
					: `模型已连续 ${nextSameToolStreak} 次重复同一操作 (${toolName}) 且无进展，疑似停滞！`;

			return {
				isLoop: true,
				isHardLimit,
				loopType: "action_stagnation",
				streak: nextSameToolStreak,
				warningMessage,
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

		// 成功 = 有进展，停滞计数清零（参数变化或成功即清零）
		this.sameToolStreak = 0;

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

		// 参数变化 = 新操作，清零；仅当同一操作被反复拒绝（无进展）时才累计停滞
		if (this.lastToolName === toolName && this.lastInputKey === currentKey) {
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
