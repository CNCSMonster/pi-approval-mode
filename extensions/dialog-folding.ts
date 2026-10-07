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
 * 详情折叠版式计算与格式化结果
 */
export interface FoldedDetailResult {
	lines: string[];
	isFoldable: boolean;
	totalVisualLines: number;
	totalChars: number;
}

export interface FormatDetailOptions {
	content: string;
	width: number;
	isExpanded: boolean;
	indent?: string;
	contIndent?: string;
	maxExpandedLines?: number;
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
		const displayLines = isExceededBudget
			? rawVisualLines.slice(0, maxExpandedLines)
			: rawVisualLines;

		for (const l of displayLines) {
			lines.push(theme.fg("text", l));
		}

		if (isExceededBudget) {
			const omitted = rawVisualLineCount - maxExpandedLines;
			const hint = `⋯ (受终端高度预算限制已展开至 ${maxExpandedLines} 行，余 ${omitted} 行未展示，按 v 或 Ctrl+O 折叠) ⋯`;
			for (const hl of wrapDialogLine(hint, safeWidth, indent, contIndent)) {
				lines.push(theme.fg("muted", hl));
			}
		} else {
			const hint = `[已展开完整内容，按 v 或 Ctrl+O 折叠收起]`;
			for (const hl of wrapDialogLine(hint, safeWidth, indent, contIndent)) {
				lines.push(theme.fg("muted", hl));
			}
		}

		return {
			lines,
			isFoldable: true,
			totalVisualLines: rawVisualLineCount,
			totalChars,
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

	return {
		lines,
		isFoldable: true,
		totalVisualLines: rawVisualLineCount,
		totalChars,
	};
}

/**
 * 高度预算计算结果
 */
export interface HeightBudget {
	isDegraded: boolean;
	maxDialogHeight: number;
	minTranscriptRows: number;
	maxDetailsLines: number;
}

/**
 * 根据终端总行数计算高度预算
 * - 标准模式 (terminalRows > 28): 保留 >= 55% 且 >= 10 行视口给 transcript
 * - 矮终端降级 (terminalRows <= 28): 保留 >= 6 行视口给 transcript
 */
export function calculateHeightBudget(terminalRows: number, chromeHeight = 13): HeightBudget {
	const H = Math.max(10, terminalRows);
	const isDegraded = H <= 28;

	const minTranscriptRows = isDegraded ? 6 : Math.max(10, Math.ceil(H * 0.55));
	const maxDialogHeight = Math.max(1, H - minTranscriptRows);
	const maxDetailsLines = Math.max(5, maxDialogHeight - chromeHeight);

	return {
		isDegraded,
		maxDialogHeight,
		minTranscriptRows,
		maxDetailsLines,
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
