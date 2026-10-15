/**
 * 审批弹窗高度预算控制、详情折叠与批次感知模块
 *
 * 核心能力：
 * 1. wrapDialogLine - 视口自适应换行，首行与续行独立缩进保护
 * 2. consolidateBlankLines - 连续空白行合并为带数量提示的单行，防填充攻击
 * 3. truncateLongLogicLine - 单逻辑行超长截断（最多 2 个视觉行，行内头尾双显并标示省略字符数）
 * 4. formatFoldableDetail - 详情视觉行折叠与展开格式化（≤5行直出、省≥2行才折叠、头3尾2折叠态）
 * 5. calculateHeightBudget - 依据真实终端行数动态计算高度预算与保底 transcript 视口
 * 6. resolveBatchProgress - 从调用上下文可靠解析批次进度 (batchTotal / batchIndex)
 * 7. formatDialogTitleWithBatch - 组合标题与批次进度指示
 */

import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * 视口宽度内自适应换行，首行与续行可设独立缩进。
 *
 * @param str 待展示内容（可含 ANSI 样式与 \n）
 * @param width 当前视口宽度（渲染侧已做下限保护）
 * @param indent 首行缩进
 * @param contIndent 续行缩进（默认与 indent 相同；传前缀类 indent 时应给等宽空格）
 */
export function wrapDialogLine(str: string, width: number, indent = "", contIndent = indent): string[] {
	const reserve = Math.max(visibleWidth(indent), visibleWidth(contIndent));
	const wrapWidth = Math.max(1, width - reserve);
	return wrapTextWithAnsi(str, wrapWidth).map((line, i) => (i === 0 ? indent : contIndent) + line);
}

/**
 * 连续空白行合并为带数量提示的单行
 * - 连续 >= 2 个空白行合并为 ⋯ (N 个空行) ⋯
 * - 单空白行原样保留 ""
 */
export function consolidateBlankLines(lines: string[]): string[] {
	const result: string[] = [];
	let blankCount = 0;

	for (const line of lines) {
		if (line.trim() === "") {
			blankCount++;
		} else {
			if (blankCount === 1) {
				result.push("");
			} else if (blankCount >= 2) {
				result.push(`⋯ (${blankCount} 个空行) ⋯`);
			}
			blankCount = 0;
			result.push(line);
		}
	}

	if (blankCount === 1) {
		result.push("");
	} else if (blankCount >= 2) {
		result.push(`⋯ (${blankCount} 个空行) ⋯`);
	}

	return result;
}

/**
 * 单逻辑行超长截断：
 * - 单个逻辑行最多展示 2 个视觉行；
 * - 超出部分在行内头尾双显截断并标示省略字符数；
 * - 换行后 <= 2 个视觉行的单逻辑行保持原样不变。
 */
export function truncateLongLogicLine(
	line: string,
	width: number,
	indent = "    ",
	contIndent = indent,
): string {
	const wrapped = wrapDialogLine(line, width, indent, contIndent);
	if (wrapped.length <= 2) {
		return line;
	}

	const reserve = Math.max(visibleWidth(indent), visibleWidth(contIndent));
	const wrapWidth = Math.max(1, width - reserve);

	// 目标：使组合后的行在 width 下换行后严格 <= 2 个视觉行
	let headChars = Math.min(line.length - 1, Math.max(4, wrapWidth));
	let tailChars = Math.min(line.length - headChars - 1, Math.max(4, Math.floor(wrapWidth / 2)));

	if (headChars + tailChars >= line.length) {
		headChars = Math.max(1, Math.floor(line.length / 2) - 1);
		tailChars = Math.max(1, line.length - headChars - 1);
	}

	while (headChars > 1 || tailChars > 1) {
		const omitted = line.length - headChars - tailChars;
		if (omitted <= 0) break;
		const marker = ` … (+${omitted.toLocaleString()} 字符) … `;
		const candidate = line.slice(0, headChars) + marker + line.slice(line.length - tailChars);
		const testWrapped = wrapDialogLine(candidate, width, indent, contIndent);
		if (testWrapped.length <= 2) {
			return candidate;
		}

		// 超过 2 行，优先缩短尾部；尾部过短时缩短头部
		if (tailChars > 4) {
			tailChars = Math.max(2, tailChars - 2);
		} else if (headChars > 4) {
			headChars = Math.max(2, headChars - 2);
		} else {
			tailChars = Math.max(1, tailChars - 1);
			headChars = Math.max(1, headChars - 1);
		}
	}

	const omitted = Math.max(0, line.length - headChars - tailChars);
	return line.slice(0, headChars) + ` … (+${omitted.toLocaleString()} 字符) … ` + line.slice(line.length - tailChars);
}

/**
 * 单行物理列宽强制裁剪：
 * 使用 visibleWidth 计算物理显示列宽（全角/CJK/Emoji 等），
 * 超过 maxWidth 时精确截断并补省略号 "…"，确保单行物理宽度严格 <= maxWidth，
 * 杜绝在窄屏终端下因软折行产生未预期的高度溢出。
 */
export function truncateVisualLine(str: string, maxWidth: number): string {
	const safeMax = Math.max(1, maxWidth);
	if (visibleWidth(str) <= safeMax) {
		return str;
	}

	let low = 0;
	let high = str.length;
	let best = 0;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const slice = str.slice(0, mid);
		if (visibleWidth(slice + "…") <= safeMax) {
			best = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return str.slice(0, best) + "…";
}

/**
 * 详情项数据结构
 */
export interface DialogDetailItem {
	label: string;
	content: string;
}

/**
 * 诊断元数据优先级全序权重：
 * 🚨 致命安全/死循环预警 (P0) > ⛔ 拦截原因 (P1) > ⚠️ 降级说明 (P2) > 操作摘要 (P3) > 静态特征 (P4) > 🔧 排障建议 (P5)
 */
export function getMetadataPriority(label: string): number {
	if (label.includes("死循环") || label.includes("致命") || label.includes("高危")) return 0;
	if (label.includes("拦截原因")) return 1;
	if (label.includes("降级") || label.includes("熔断")) return 2;
	if (label.includes("操作摘要")) return 3;
	if (label.includes("静态结构") || label.includes("特征")) return 4;
	if (label.includes("排障") || label.includes("建议")) return 5;
	return 6;
}

/**
 * 详情折叠版式计算与格式化结果
 */
export interface FoldedDetailResult {
	lines: string[];
	isFoldable: boolean;
	totalVisualLines: number;
	totalChars: number;
	hasMorePages?: boolean;
	contentBudget?: number;
	maxOffset?: number;
	step?: number;
}

export interface FormatDetailOptions {
	content: string;
	width: number;
	isExpanded: boolean;
	indent?: string;
	contIndent?: string;
	maxExpandedLines?: number;
	pageOffset?: number;
}

/**
 * 格式化详情项的展示行。
 * 遵循严格范围与决策：
 * 1. 详情最多 5 个视觉行时完整显示；
 * 2. 只有折叠确实隐藏至少 2 个视觉行时才折叠（总视觉行数 >= 7）；
 * 3. 折叠态展示头 3 个视觉行和尾 2 个视觉行，中间提示省略数；
 * 4. 超长单逻辑行在折叠态最多展示 2 个视觉行，行内头尾双显截断；
 * 5. 展开态展示全部视觉行，末尾追加折叠提示；若超出终端高度预算上限，则受限展示并提示。
 */
export function formatFoldableDetail(
	options: FormatDetailOptions,
	theme: { fg: (color: string, text: string) => string },
): FoldedDetailResult {
	const {
		content,
		width,
		isExpanded,
		indent = "    ",
		contIndent = indent,
		maxExpandedLines = 50,
	} = options;

	const safeWidth = Math.max(10, width);
	const rawLines = content.split("\n");
	const consolidated = consolidateBlankLines(rawLines);
	const totalChars = content.length;

	// 计算无单行截断时的原始视觉行列表
	const rawVisualLines: string[] = [];
	for (const line of consolidated) {
		for (const vl of wrapDialogLine(line, safeWidth, indent, contIndent)) {
			rawVisualLines.push(vl);
		}
	}
	const rawVisualLineCount = rawVisualLines.length;

	// 规则 1：详情最多 5 个视觉行时完整显示
	// 规则 2：只有折叠确实隐藏至少 2 个视觉行时才折叠（rawVisualLineCount - 5 >= 2，即 >= 7）
	const isFoldable = rawVisualLineCount >= 7;

	if (!isFoldable) {
		const lines = rawVisualLines.map((vl) => theme.fg("text", vl));
		return {
			lines,
			isFoldable: false,
			totalVisualLines: rawVisualLineCount,
			totalChars,
		};
	}

	// 展开态
	if (isExpanded) {
		const lines: string[] = [];
		const isExceededBudget = rawVisualLines.length > maxExpandedLines;
		const offset = Math.max(0, options.pageOffset ?? 0);

		if (!isExceededBudget) {
			for (const l of rawVisualLines) {
				lines.push(theme.fg("text", l));
			}
			const hint = `[已展开完整内容，按 v 或 Ctrl+O 折叠收起]`;
			for (const hl of wrapDialogLine(hint, safeWidth, indent, contIndent)) {
				lines.push(theme.fg("muted", hl));
			}
			return {
				lines,
				isFoldable: true,
				totalVisualLines: rawVisualLineCount,
				totalChars,
				hasMorePages: false,
			};
		}

		// 超出单屏预算：执行两遍无依赖槽位判定算法，杜绝末页槽位循环依赖
		const topSlot = offset > 0 ? 1 : 0;

		// Pass 1: 假定保留底槽（占用 1 行），计算保守净正文预算
		const cbWithBottom = Math.max(1, maxExpandedLines - topSlot - 1);

		// Pass 2: 检查保守预算下是否还有未显示内容
		const hasMoreBelow = (offset + cbWithBottom) < rawVisualLineCount;

		// 底部槽位决策：
		// 下方有剩余行时为 1（显示未完提示）；
		// 下方无剩余行但上方有偏移时为 1（显示已触底提示，恒定占位防高度突增）；
		// 仅当首屏在预留底槽前提下即可看完全部内容时为 0
		const bottomSlot = hasMoreBelow ? 1 : (topSlot > 0 ? 1 : 0);
		const contentBudget = bottomSlot > 0 ? cbWithBottom : Math.max(1, maxExpandedLines - topSlot);

		const sliceStart = Math.min(rawVisualLineCount, Math.max(0, offset));
		const sliceEnd = Math.min(rawVisualLineCount, sliceStart + contentBudget);
		const displayLines = rawVisualLines.slice(sliceStart, sliceEnd);

		const maxOffset = Math.max(0, rawVisualLineCount - Math.max(1, maxExpandedLines - 2));
		const step = Math.max(1, contentBudget - 2);

		if (topSlot > 0) {
			const topHint = `▲ 已上翻 (上方余 ${sliceStart} 行) · [Home/g 顶 | PgUp 上翻]`;
			for (const hl of wrapDialogLine(topHint, safeWidth, indent, contIndent)) {
				lines.push(theme.fg("muted", hl));
			}
		}

		for (const l of displayLines) {
			lines.push(theme.fg("text", l));
		}

		if (bottomSlot > 0) {
			if (sliceEnd < rawVisualLineCount) {
				const omitted = rawVisualLineCount - sliceEnd;
				const bottomHint = `▼ [行 ${sliceStart + 1}–${sliceEnd} / 共 ${rawVisualLineCount} 行] (余 ${omitted} 行) · [End/G 底 | PgDn 下翻 | v 收起]`;
				for (const hl of wrapDialogLine(bottomHint, safeWidth, indent, contIndent)) {
					lines.push(theme.fg("muted", hl));
				}
			} else {
				const bottomHint = `✔ [已到底部 (共 ${rawVisualLineCount} 行)] · [Enter 确认 | Esc/v 收起]`;
				for (const hl of wrapDialogLine(bottomHint, safeWidth, indent, contIndent)) {
					lines.push(theme.fg("muted", hl));
				}
			}
		}

		return {
			lines,
			isFoldable: true,
			totalVisualLines: rawVisualLineCount,
			totalChars,
			hasMorePages: topSlot > 0 || bottomSlot > 0,
			contentBudget,
			maxOffset,
			step,
		};
	}

	// 折叠态 (Compact Mode): 头 3 视觉行 + 折叠提示 + 尾 2 视觉行
	// 对各逻辑行应用超长单逻辑行上限（最多 2 个视觉行）
	const protectedLines: string[] = [];
	for (const line of consolidated) {
		const truncated = truncateLongLogicLine(line, safeWidth, indent, contIndent);
		for (const vl of wrapDialogLine(truncated, safeWidth, indent, contIndent)) {
			protectedLines.push(vl);
		}
	}

	const lines: string[] = [];
	const headCount = 3;
	const tailCount = 2;

	if (protectedLines.length < headCount + tailCount) {
		// 当单逻辑行超长截断后总视觉行数不足 5 行时（如单行超长截断为 2 行，行内已首尾双显）
		for (const l of protectedLines) {
			lines.push(theme.fg("text", l));
		}
		const hiddenCount = Math.max(1, rawVisualLineCount - protectedLines.length);
		const foldHint = `⋯ (还有 ${hiddenCount} 视觉行未展示，共 ${rawVisualLineCount} 视觉行，按 v 或 Ctrl+O 展开) ⋯`;
		for (const hl of wrapDialogLine(foldHint, safeWidth, indent, contIndent)) {
			lines.push(theme.fg("muted", hl));
		}
	} else {
		// 头 3 视觉行
		const headLines = protectedLines.slice(0, headCount);
		for (const l of headLines) {
			lines.push(theme.fg("text", l));
		}

		// 中间折叠提示行
		const hiddenCount = Math.max(1, rawVisualLineCount - (headCount + tailCount));
		const foldHint = `⋯ (还有 ${hiddenCount} 视觉行未展示，共 ${rawVisualLineCount} 视觉行，按 v 或 Ctrl+O 展开) ⋯`;
		for (const hl of wrapDialogLine(foldHint, safeWidth, indent, contIndent)) {
			lines.push(theme.fg("muted", hl));
		}

		// 尾 2 视觉行
		const tailLines = protectedLines.slice(-tailCount);
		for (const l of tailLines) {
			lines.push(theme.fg("text", l));
		}
	}

	const defaultContentBudget = Math.max(1, maxExpandedLines - 2);
	const defaultMaxOffset = Math.max(0, rawVisualLineCount - defaultContentBudget);
	const defaultStep = Math.max(1, defaultContentBudget - 2);

	return {
		lines,
		isFoldable: true,
		totalVisualLines: rawVisualLineCount,
		totalChars,
		contentBudget: defaultContentBudget,
		maxOffset: defaultMaxOffset,
		step: defaultStep,
	};
}

/**
 * 高度预算计算结果
 */
export interface HeightBudget {
	isDegraded: boolean;
	isLockedCompact: boolean;
	tier: "locked" | "compact" | "footer_expanded" | "meta_expanded" | "standard";
	chromeHeight: number;
	headerLines: number;
	metaLines: number;
	footerLines: number;
	expandedHeroCapacity: number;
	safeHeight: number;
	maxDialogHeight: number;
	minTranscriptRows: number;
	maxDetailsLines: number;
}

/**
 * 依据真实终端行数动态计算高度预算：
 * 采用铬饰平滑渐进式分配律与 H_min=16 刚性守卫：
 * 1. H < 16: 极矮锁定态，禁止展开，锁定紧凑摘要；
 * 2. 16 <= H <= 25: 紧凑基础态 (Chrome=9)，W_hero = H - 10 (单调递增，H=24 时为 14)；
 * 3. 26 <= H <= 27: 舒展页脚态 (Chrome=10)，W_hero = H - 11 (平滑无反缩)；
 * 4. 28 <= H <= 29: 双行诊断态 (Chrome=11)，W_hero = H - 12 (平滑无反缩)；
 * 5. H >= 30: 标准全量态 (Chrome=12)，W_hero = H - 13 (平滑无反缩)。
 * 任意 H 跃迁点严格满足 Delta W_hero >= 0。
 */
export function calculateHeightBudget(terminalRows: number, _defaultChromeHeight = 13): HeightBudget {
	const H = Math.max(1, terminalRows);
	const safeHeight = Math.max(1, H - 1);

	if (H < 16) {
		const chromeHeight = 9;
		const minTranscriptRows = Math.max(1, H - chromeHeight);
		return {
			isDegraded: true,
			isLockedCompact: true,
			tier: "locked",
			chromeHeight,
			headerLines: 2,
			metaLines: 1,
			footerLines: 6,
			expandedHeroCapacity: 0,
			safeHeight,
			maxDialogHeight: Math.min(H, chromeHeight),
			minTranscriptRows,
			maxDetailsLines: 5,
		};
	}

	if (H <= 25) {
		const chromeHeight = 9;
		const expandedHeroCapacity = H - 10;
		const minTranscriptRows = Math.max(1, Math.min(6, Math.floor(H * 0.25)));
		return {
			isDegraded: true,
			isLockedCompact: false,
			tier: "compact",
			chromeHeight,
			headerLines: 2,
			metaLines: 1,
			footerLines: 6,
			expandedHeroCapacity,
			safeHeight,
			maxDialogHeight: safeHeight,
			minTranscriptRows,
			maxDetailsLines: Math.max(5, expandedHeroCapacity),
		};
	}

	if (H <= 27) {
		const chromeHeight = 10;
		const expandedHeroCapacity = H - 11;
		const minTranscriptRows = Math.max(6, Math.floor(H * 0.3));
		return {
			isDegraded: false,
			isLockedCompact: false,
			tier: "footer_expanded",
			chromeHeight,
			headerLines: 2,
			metaLines: 1,
			footerLines: 7,
			expandedHeroCapacity,
			safeHeight,
			maxDialogHeight: safeHeight,
			minTranscriptRows,
			maxDetailsLines: Math.max(5, expandedHeroCapacity),
		};
	}

	if (H <= 29) {
		const chromeHeight = 11;
		const expandedHeroCapacity = H - 12;
		const minTranscriptRows = Math.max(6, Math.floor(H * 0.3));
		return {
			isDegraded: false,
			isLockedCompact: false,
			tier: "meta_expanded",
			chromeHeight,
			headerLines: 2,
			metaLines: 2,
			footerLines: 7,
			expandedHeroCapacity,
			safeHeight,
			maxDialogHeight: safeHeight,
			minTranscriptRows,
			maxDetailsLines: Math.max(5, expandedHeroCapacity),
		};
	}

	// H >= 30
	const chromeHeight = 12;
	const expandedHeroCapacity = H - 13;
	const minTranscriptRows = Math.max(10, Math.ceil(H * 0.4));
	return {
		isDegraded: false,
		isLockedCompact: false,
		tier: "standard",
		chromeHeight,
		headerLines: 3,
		metaLines: 2,
		footerLines: 7,
		expandedHeroCapacity,
		safeHeight,
		maxDialogHeight: safeHeight,
		minTranscriptRows,
		maxDetailsLines: Math.max(5, expandedHeroCapacity),
	};
}

/**
 * 批次进度信息
 */
export interface BatchProgress {
	batchIndex: number;
	batchTotal: number;
}

/**
 * 从当前调用上下文可靠解析批次进度 (batchTotal / batchIndex)
 * 仅当能从 sessionManager.getBranch() 中找到包含当前 toolCallId 的最新 Assistant 消息时返回
 */
export function resolveBatchProgress(
	sessionManager: any,
	toolCallId?: string,
): BatchProgress | undefined {
	if (!sessionManager || typeof sessionManager.getBranch !== "function" || !toolCallId) {
		return undefined;
	}

	try {
		const branch = sessionManager.getBranch();
		if (!Array.isArray(branch) || branch.length === 0) {
			return undefined;
		}

		// 倒序查找包含当前 toolCallId 的最新 Assistant 消息
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			const msg = entry?.message ?? entry;
			if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
				const toolCalls = msg.content.filter((c: any) => c && c.type === "toolCall");
				const idx = toolCalls.findIndex((c: any) => c.id === toolCallId);
				if (idx !== -1) {
					const batchTotal = toolCalls.length;
					if (batchTotal > 1) {
						return { batchIndex: idx + 1, batchTotal };
					}
					return undefined;
				}
			}
		}
	} catch {
		return undefined;
	}

	return undefined;
}

/**
 * 为弹窗标题注入批次进度指示
 * 例："[Manual 审批] bash: npm test" -> "[Manual 审批] (批次 2/3) bash: npm test"
 */
export function formatDialogTitleWithBatch(baseTitle: string, batch?: BatchProgress): string {
	if (!batch) return baseTitle;

	const prefixMatch = baseTitle.match(/^(\[[^\]]+\])\s*(.*)$/);
	if (prefixMatch) {
		const prefix = prefixMatch[1];
		const rest = prefixMatch[2];
		return `${prefix} (批次 ${batch.batchIndex}/${batch.batchTotal}) ${rest}`;
	}

	return `(批次 ${batch.batchIndex}/${batch.batchTotal}) ${baseTitle}`;
}
