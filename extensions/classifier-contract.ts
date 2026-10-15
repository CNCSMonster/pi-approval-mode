/**
 * 分类器文本流契约解析器 (Classifier Response Contract Parser)
 *
 * 核心架构哲学：
 * 1. 在异构多模型与自由文本流环境下，采用 Markdown / 纯文本键值对作为一等公民契约；
 * 2. 贯彻“不清楚一律 DENY”的二态安全铁律；
 * 3. 实行全量扫描 + 冲突熔断 (Conflict Fail-Closed)：
 *    若输出中检测到相互矛盾的判决信号（如攻击者注入的伪造 ALLOW 与模型自身的 DENY 混杂），
 *    一律判定为判决冲突并强制按 DENY 保守拦截；
 * 4. 尾部判决块锚定：在无冲突前提下采信末尾最后一个有效判决块，并实现 DECISION/REASON/SUMMARY 同块绑定；
 * 5. 全向后兼容：对标准 JSON、Markdown ```json 代码块及历史 shouldBlock 字段保持宽容兼容。
 */

export type ClassifierDecisionType = "ALLOW" | "DENY";

export interface ParsedClassifierContract {
	ok: boolean;
	decision: ClassifierDecisionType;
	shouldBlock: boolean;
	reason: string;
	summary?: string;
	analysis?: string;
	intent?: string;
	format: "markdown" | "json_block" | "raw_json" | "fallback_unparseable";
	conflictDetected?: boolean;
}

interface ExtractedSignal {
	decision: ClassifierDecisionType;
	reason?: string;
	summary?: string;
	analysis?: string;
	intent?: string;
	format: "markdown" | "json_block" | "raw_json";
	index: number;
}

/**
 * 解析分类器输出的自由文本，提取最终权威判决
 */
export function parseClassifierResponse(rawText: string): ParsedClassifierContract {
	if (!rawText || typeof rawText !== "string") {
		return {
			ok: false,
			decision: "DENY",
			shouldBlock: true,
			reason: "分类器返回空文本响应",
			format: "fallback_unparseable",
		};
	}

	const trimmed = rawText.trim();
	const signals: ExtractedSignal[] = [];

	// 1. 扫描所有 Markdown / 纯文本行键值对 (支持标题、列表项、加粗等常见 Markdown 变体)
	// 匹配示例：
	// DECISION: ALLOW
	// **DECISION**: DENY
	// ## Decision: ALLOW
	// - DECISION : ALLOW
	const lineRegex =
		/(?:^|\n)\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?(?:DECISION|VERDICT|OUTCOME)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?(ALLOW|DENY|BLOCK)(?:\*\*|__)?(?![a-zA-Z-])/gi;

	let match: RegExpExecArray | null;
	while ((match = lineRegex.exec(trimmed)) !== null) {
		const rawVal = match[1].toUpperCase();
		const decision: ClassifierDecisionType = rawVal === "ALLOW" ? "ALLOW" : "DENY";
		const matchIndex = match.index;
		const ctxFields = extractContextFields(trimmed, matchIndex);

		signals.push({
			decision,
			reason: ctxFields.reason,
			summary: ctxFields.summary,
			analysis: ctxFields.analysis,
			intent: ctxFields.intent,
			format: "markdown",
			index: matchIndex,
		});
	}

	// 1b. 扫描独立行判词 (模型直接单行输出 ALLOW 或 DENY / BLOCK)
	const standaloneLineRegex =
		/(?:^|\n)\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?(ALLOW|DENY|BLOCK)(?:\*\*|__)?\s*(?:\n|$)/gi;

	while ((match = standaloneLineRegex.exec(trimmed)) !== null) {
		const rawVal = match[1].toUpperCase();
		const decision: ClassifierDecisionType = rawVal === "ALLOW" ? "ALLOW" : "DENY";
		const matchIndex = match.index;

		// 避免与步骤 1 的前缀匹配重复记录
		if (signals.some((s) => Math.abs(s.index - matchIndex) < 20)) {
			continue;
		}

		const ctxFields = extractContextFields(trimmed, matchIndex);

		signals.push({
			decision,
			reason: ctxFields.reason,
			summary: ctxFields.summary,
			analysis: ctxFields.analysis,
			intent: ctxFields.intent,
			format: "markdown",
			index: matchIndex,
		});
	}

	// 2. 扫描所有 ```json 代码块
	const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
	while ((match = fenceRegex.exec(trimmed)) !== null) {
		const blockContent = match[1].trim();
		const parsed = tryParseJsonPayload(blockContent);
		if (parsed) {
			signals.push({
				...parsed,
				format: "json_block",
				index: match.index,
			});
		}
	}

	// 3. 扫描裸 JSON 候选 (若没有匹配到 Markdown 且没有匹配到代码块，或用于全面冲突审查)
	const rawJsonRegex = /\{[\s\S]*?\}/g;
	while ((match = rawJsonRegex.exec(trimmed)) !== null) {
		const jsonSnippet = match[0].trim();
		const parsed = tryParseJsonPayload(jsonSnippet);
		if (parsed) {
			// 避免与已解析的 code block 重复记录同一位置
			const alreadyCaptured = signals.some(
				(s) => Math.abs(s.index - match!.index) < 10 && s.decision === parsed.decision,
			);
			if (!alreadyCaptured) {
				signals.push({
					...parsed,
					format: "raw_json",
					index: match.index,
				});
			}
		}
	}

	// 4. 安全共识与冲突审计 (Conflict Audit)
	if (signals.length === 0) {
		// 严禁无前缀模糊扫描；无法无歧义锚定契约时守住“不清楚一律 DENY”铁律
		return {
			ok: false,
			decision: "DENY",
			shouldBlock: true,
			reason: "未能识别到有效的结构化或 Markdown 判决契约 (格式不合规)",
			format: "fallback_unparseable",
		};
	}

	const hasAllow = signals.some((s) => s.decision === "ALLOW");
	const hasDeny = signals.some((s) => s.decision === "DENY");

	// 判决冲突熔断：只要同时存在 ALLOW 与 DENY 信号，无条件一律 DENY，彻底封死前置注入伪造
	if (hasAllow && hasDeny) {
		return {
			ok: false,
			decision: "DENY",
			shouldBlock: true,
			reason: "检测到相互矛盾的分类器判决信号 (安全冲突熔断，一律拦截)",
			format: "fallback_unparseable",
			conflictDetected: true,
		};
	}

	// 5. 尾部锚定采信：采信按文本物理位置最靠后的一个信号
	signals.sort((a, b) => a.index - b.index);
	const authoritative = signals[signals.length - 1];

	return {
		ok: true,
		decision: authoritative.decision,
		shouldBlock: authoritative.decision === "DENY",
		reason: authoritative.reason || (authoritative.decision === "ALLOW" ? "常规良性操作放行" : "安全检查要求人工确认"),
		summary: authoritative.summary,
		analysis: authoritative.analysis,
		intent: authoritative.intent,
		format: authoritative.format,
	};
}

/**
 * 辅助函数：提取判决行上下文关联字段（双向扫描 REASON / SUMMARY / INTENT / ANALYSIS）
 */
function extractContextFields(
	trimmed: string,
	matchIndex: number,
): {
	reason?: string;
	summary?: string;
	intent?: string;
	analysis?: string;
} {
	const sliceBefore = trimmed.slice(Math.max(0, matchIndex - 600), matchIndex);
	const sliceAfter = trimmed.slice(matchIndex);

	// REASON: 优先紧邻前置或紧邻后置
	const reasonAfterMatch = sliceAfter.match(
		/(?:^|\n)\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?(?:REASON|RATIONALE)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?([^\n\r]+)/i,
	);
	const reasonBeforeMatch = sliceBefore.match(
		/(?:^|\n)\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?(?:REASON|RATIONALE)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?([^\n\r]+)/i,
	);
	const reason = reasonAfterMatch
		? cleanMarkdownValue(reasonAfterMatch[1])
		: reasonBeforeMatch
			? cleanMarkdownValue(reasonBeforeMatch[1])
			: undefined;

	// SUMMARY: 优先后置或前置
	const summaryAfterMatch = sliceAfter.match(
		/(?:^|\n)\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?(?:SUMMARY)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?([^\n\r]+)/i,
	);
	const summaryBeforeMatch = sliceBefore.match(
		/(?:^|\n)\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?(?:SUMMARY)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?([^\n\r]+)/i,
	);
	const summary = summaryAfterMatch
		? cleanMarkdownValue(summaryAfterMatch[1])
		: summaryBeforeMatch
			? cleanMarkdownValue(summaryBeforeMatch[1])
			: undefined;

	// INTENT: 工具意图
	const intentMatch = trimmed.match(
		/(?:^|\n)\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?(?:INTENT|GOAL)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?([^\n\r]+)/i,
	);
	const intent = intentMatch ? cleanMarkdownValue(intentMatch[1]) : undefined;

	// ANALYSIS: 逻辑推演分析
	const analysisMatch = trimmed.match(
		/(?:^|\n)\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?(?:ANALYSIS)(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?([\s\S]*?)(?=(?:\n\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?(?:INTENT|REASON|DECISION|SUMMARY|VERDICT)\b)|$)/i,
	);
	const analysis = analysisMatch ? cleanMarkdownValue(analysisMatch[1].trim()) : undefined;

	return { reason, summary, intent, analysis };
}

/**
 * 辅助函数：尝试将文本片段反序列化为分类器决策载荷
 */
function tryParseJsonPayload(
	text: string,
): { decision: ClassifierDecisionType; reason?: string; summary?: string } | null {
	try {
		const obj = JSON.parse(text);
		if (!obj || typeof obj !== "object") return null;

		let decision: ClassifierDecisionType | undefined;

		// 1. 优先提取字符串风格契约 (decision / verdict / outcome)
		const candidateStr =
			typeof obj.decision === "string"
				? obj.decision
				: typeof obj.verdict === "string"
					? obj.verdict
					: typeof obj.outcome === "string"
						? obj.outcome
						: undefined;

		if (candidateStr) {
			const upper = candidateStr.trim().toUpperCase();
			if (upper === "ALLOW") decision = "ALLOW";
			else if (upper === "DENY" || upper === "BLOCK") decision = "DENY";
		}

		// 2. 向后兼容布尔风格 shouldBlock 契约
		if (!decision && typeof obj.shouldBlock === "boolean") {
			decision = obj.shouldBlock ? "DENY" : "ALLOW";
		}

		if (!decision) return null;

		const reason =
			typeof obj.reason === "string"
				? obj.reason.trim()
				: typeof obj.rationale === "string"
					? obj.rationale.trim()
					: undefined;

		const summary = typeof obj.summary === "string" ? obj.summary.trim() : undefined;

		return { decision, reason, summary };
	} catch {
		return null;
	}
}

/**
 * 清理 Markdown 提取出的末尾多余标点与格式
 */
function cleanMarkdownValue(val: string): string {
	let res = val.trim();
	// 剥离外层成对的 ** 或 __ 或 *
	if ((res.startsWith("**") && res.endsWith("**")) || (res.startsWith("__") && res.endsWith("__"))) {
		res = res.slice(2, -2).trim();
	} else if (res.startsWith("*") && res.endsWith("*")) {
		res = res.slice(1, -1).trim();
	}
	return res;
}
