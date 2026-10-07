import type { DenialLimits } from "../extensions/denial-tracker.ts";

/**
 * 专为微型状态机测试设计的标准限额预设
 * 编译器由 satisfies Required<DenialLimits> 强制保证包含全部阈值字段，杜绝任何生产默认值的隐式穿透。
 */
export const MICRO_TEST_LIMITS = {
	maxConsecutiveBlock: 3,
	maxConsecutiveUnavailable: 3,
	maxTotalDenials: 4,
} as const satisfies Required<DenialLimits>;
