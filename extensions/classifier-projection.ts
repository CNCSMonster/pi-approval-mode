/**
 * Classifier Tool Input Projection & Transcript Construction
 *
 * 为 LLM 安全分类器提供两件能力（对齐 qwen-code 的 classifier-transcript.ts 与 toAutoClassifierInput）：
 *
 * 1. 参数投影（projectToolInput）：只暴露安全判断所需的最小字段 + 字符截断，
 *    替代 `JSON.stringify(input)` 全量暴露；
 * 2. Transcript 构造（buildTranscript）：按过滤铁律裁剪会话历史——
 *    保留 user 意图、改写历史 toolCall、剥离 assistant 文本 / toolResult 等不可信内容。
 *
 * 常量单一来源：窗口大小 / 预览长度 / edit 投影上限均集中于此。
 */

import { Buffer } from "node:buffer";

/** Transcript 窗口：最近 N 条 message entry（对齐 qwen-code `MAX_TRANSCRIPT_MESSAGES = 40`）。 */
export const MAX_TRANSCRIPT_MESSAGES = 40;

/** 投影预览长度：单个字符串字段最多暴露的字符数（对齐 qwen-code 的 300 字符窗口）。 */
export const PROJECTION_PREVIEW_LENGTH = 300;

/** edit 工具多区块投影上限：仅投影前 N 个 edit 块，其余计入 edits_count。 */
export const EDIT_PREVIEW_MAX = 5;

/**
 * 投影工具输入参数为分类器可见的最小字段集。
 *
 * @param toolName 工具名（pi 工具：bash / edit / write / read / ...）
 * @param input    工具调用原始参数
 * @param cwd      当前工作目录（bash 投影需要）
 */
export function projectToolInput(
	toolName: string,
	input: Record<string, any>,
	cwd: string,
): Record<string, any> {
	switch (toolName) {
		case "bash":
			return projectBashInput(input, cwd);
		case "edit":
			return projectEditInput(input);
		case "write":
			return projectWriteInput(input);
		case "read":
			// 读类投影：只暴露目标路径，不暴露文件内容
			return { path: typeof input.path === "string" ? input.path : "" };
		case "grep":
		case "find":
			return {
				path: typeof input.path === "string" ? input.path : "",
				pattern: typeof input.pattern === "string" ? input.pattern : "",
			};
		case "ls":
			return { path: typeof input.path === "string" ? input.path : "" };
		default:
			// 未知工具 → 最小化投影，安全优先
			return { toolName };
	}
}

function projectBashInput(input: Record<string, any>, cwd: string): Record<string, any> {
	return {
		command: typeof input.command === "string" ? input.command : "",
		cwd,
	};
}

function projectEditInput(input: Record<string, any>): Record<string, any> {
	const edits = Array.isArray(input.edits) ? input.edits : [];

	const previews = edits.slice(0, EDIT_PREVIEW_MAX).map((edit: any) => {
		const oldText = edit && typeof edit.oldText === "string" ? edit.oldText : "";
		const newText = edit && typeof edit.newText === "string" ? edit.newText : "";
		const truncated =
			oldText.length > PROJECTION_PREVIEW_LENGTH || newText.length > PROJECTION_PREVIEW_LENGTH;
		return {
			old_preview: oldText.slice(0, PROJECTION_PREVIEW_LENGTH),
			new_preview: newText.slice(0, PROJECTION_PREVIEW_LENGTH),
			truncated,
		};
	});

	return {
		path: typeof input.path === "string" ? input.path : "",
		edits_count: edits.length,
		edits_preview: previews,
	};
}

function projectWriteInput(input: Record<string, any>): Record<string, any> {
	const content = typeof input.content === "string" ? input.content : "";
	return {
		path: typeof input.path === "string" ? input.path : "",
		byte_count: Buffer.byteLength(content, "utf8"),
		content_preview: content.slice(0, PROJECTION_PREVIEW_LENGTH),
		content_truncated: content.length > PROJECTION_PREVIEW_LENGTH,
	};
}

// ==============================================================
// Transcript 构造（对齐 qwen-code classifier-transcript.ts 过滤铁律）
// ==============================================================

/** 宽松的 session entry 视图，便于纯函数单测（不依赖 pi 运行时类型）。 */
export interface TranscriptEntryLike {
	type: string;
	message?: {
		role: string;
		content: unknown;
	};
}

/**
 * 从 message content 提取纯文本（string 或 text part 数组）。
 */
function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c) => c && typeof c === "object" && (c as any).type === "text" && typeof (c as any).text === "string")
			.map((c) => (c as any).text)
			.join("\n");
	}
	return "";
}

/**
 * 按过滤铁律构造 transcript 文本条目（最近 N 条 message entry）：
 * - user 文本 → 保留；
 * - assistant 的 toolCall → 改写为 `Prior action: xxx(投影参数)`；
 * - assistant 的 text / thinking → 剥离（防自我背书）；
 * - toolResult / bashExecution / custom 等 → 剥离（防不可信内容注入）。
 *
 * @param entries 会话 entry 列表（按时间正序，最新在末尾）
 * @param cwd     当前工作目录（投影 toolCall 时使用）
 * @returns 过滤后的文本条目（正序，可直接 join）
 */
export function buildTranscript(entries: TranscriptEntryLike[], cwd: string): string[] {
	const items: string[] = [];
	let messageCount = 0;

	for (let i = entries.length - 1; i >= 0 && messageCount < MAX_TRANSCRIPT_MESSAGES; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "message" || !entry.message) {
			continue;
		}
		messageCount++;

		const msg = entry.message;
		if (msg.role === "user") {
			const text = extractTextFromContent(msg.content).trim();
			if (text) {
				items.unshift(text);
			}
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			for (const part of content) {
				if (part && (part as any).type === "toolCall" && typeof (part as any).name === "string") {
					const projected = projectToolInput((part as any).name, (part as any).arguments ?? {}, cwd);
					items.unshift(`Prior action: ${(part as any).name}(${JSON.stringify(projected)})`);
				}
				// text / thinking part → 剥离
			}
		}
		// toolResult / bashExecution / custom / branchSummary / compactionSummary → 剥离
	}

	return items;
}
