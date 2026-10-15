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
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Transcript 窗口：最近 N 条 message entry（对齐 qwen-code `MAX_TRANSCRIPT_MESSAGES = 40`）。 */
export const MAX_TRANSCRIPT_MESSAGES = 40;

/** 投影预览长度：提升至 4000 字符（约 4KB），使常规日常代码文件不发生截断。 */
export const PROJECTION_PREVIEW_LENGTH = 4000;

/** 超长内容头部采样长度 */
export const PROJECTION_HEAD_LENGTH = 1500;

/** 超长内容尾部采样长度 */
export const PROJECTION_TAIL_LENGTH = 1500;

/** edit 工具多区块投影上限：提升至 10 个 edit 块。 */
export const EDIT_PREVIEW_MAX = 10;

/**
 * 路径投影真实目标解析结果
 */
export interface PathProjectionResult {
	path: string;
	resolved_path?: string;
	dangling_symlink?: boolean;
	resolution_failed?: boolean;
	resolved_from?: "direct" | "ancestor" | "lexical";
}

/**
 * 解析路径真实物理目标，区分三类情形：
 * 1. 目标或祖先存在（正常文件或新建文件，解析真实物理路径）
 * 2. 悬垂符号链接（链接本身存在但指向不存在目标，高危，标记 dangling_symlink: true）
 * 3. 真实解析失败（权限、循环、断链等，标记 resolution_failed: true）
 */
export function resolvePathForProjection(targetPath: string, cwd: string): PathProjectionResult {
	if (typeof targetPath !== "string" || !targetPath.trim()) {
		return { path: targetPath ?? "" };
	}
	const rawPath = targetPath;
	const fullPath = isAbsolute(targetPath) ? targetPath : resolve(cwd, targetPath);

	try {
		// 1. 检查物理状态（lstat 不跟随符号链接）
		let stat;
		try {
			stat = lstatSync(fullPath);
		} catch (err: any) {
			if (err?.code === "ENOENT") {
				// 文件不存在：向上逐级寻找最近存在的祖先目录
				let currentDir = dirname(fullPath);
				const remainingParts: string[] = [basename(fullPath)];

				while (currentDir && currentDir !== dirname(currentDir)) {
					try {
						const dirStat = lstatSync(currentDir);
						if (dirStat.isDirectory()) {
							const realAncestor = realpathSync(currentDir);
							const resolved = join(realAncestor, ...remainingParts);
							return {
								path: rawPath,
								resolved_path: resolved,
								resolved_from: "ancestor",
							};
						}
					} catch {
						remainingParts.unshift(basename(currentDir));
						currentDir = dirname(currentDir);
					}
				}
				// 祖先目录都不存在（例如 mock 虚拟路径）：词法解析回退
				return { path: rawPath, resolved_path: fullPath, resolved_from: "lexical" };
			}
			return { path: rawPath, resolution_failed: true };
		}

		// 2. 检查符号链接
		if (stat.isSymbolicLink()) {
			try {
				const real = realpathSync(fullPath);
				return { path: rawPath, resolved_path: real, resolved_from: "direct" };
			} catch (err: any) {
				if (err?.code === "ENOENT") {
					// 悬垂符号链接：链接本身存在，但目标不存在
					let linkTarget = "";
					try {
						linkTarget = readlinkSync(fullPath);
					} catch {}
					return {
						path: rawPath,
						resolved_path: linkTarget ? resolve(dirname(fullPath), linkTarget) : undefined,
						dangling_symlink: true,
					};
				}
				return { path: rawPath, resolution_failed: true };
			}
		}

		// 3. 常规文件或目录存在
		const real = realpathSync(fullPath);
		return { path: rawPath, resolved_path: real, resolved_from: "direct" };
	} catch {
		return { path: rawPath, resolution_failed: true };
	}
}

/**
 * 投影工具输入参数为分类器可见的最小字段集。
 *
 * @param toolName 工具名（pi 工具：bash / edit / write / read / ...）
 * @param input    工具调用原始参数
 * @param cwd      当前工作目录（bash 投影及路径解析需要）
 */
/** 可注入的路径解析器（重放场景以 FS Oracle 快照驱动，默认实时文件系统解析）。 */
export type ProjectionPathResolver = (targetPath: string, cwd: string) => PathProjectionResult;

export function projectToolInput(
	toolName: string,
	input: Record<string, any>,
	cwd: string,
	pathResolver?: ProjectionPathResolver,
): Record<string, any> {
	const resolver = pathResolver ?? resolvePathForProjection;
	switch (toolName) {
		case "bash":
			return projectBashInput(input, cwd);
		case "edit":
			return projectEditInput(input, cwd, resolver);
		case "write":
			return projectWriteInput(input, cwd, resolver);
		case "read":
			return projectReadInput(input, cwd, resolver);
		case "grep":
		case "find":
			return projectSearchInput(toolName, input, cwd, resolver);
		case "ls":
			return projectLsInput(input, cwd, resolver);
		default:
			// 未知工具 → 最小化投影，安全优先，附带 unknown_tool 标记
			return { toolName, unknown_tool: true };
	}
}

function projectBashInput(input: Record<string, any>, cwd: string): Record<string, any> {
	return {
		command: typeof input.command === "string" ? input.command : "",
		cwd,
	};
}

function projectReadInput(input: Record<string, any>, cwd: string, resolver: ProjectionPathResolver): Record<string, any> {
	const rawPath = typeof input.path === "string" ? input.path : "";
	const pathInfo = resolver(rawPath, cwd);
	return {
		...pathInfo,
	};
}

function projectSearchInput(toolName: string, input: Record<string, any>, cwd: string, resolver: ProjectionPathResolver): Record<string, any> {
	const rawPath = typeof input.path === "string" ? input.path : "";
	const pathInfo = resolver(rawPath, cwd);
	return {
		...pathInfo,
		pattern: typeof input.pattern === "string" ? input.pattern : "",
	};
}

function projectLsInput(input: Record<string, any>, cwd: string, resolver: ProjectionPathResolver): Record<string, any> {
	const rawPath = typeof input.path === "string" ? input.path : "";
	const pathInfo = resolver(rawPath, cwd);
	return {
		...pathInfo,
	};
}

function projectEditInput(input: Record<string, any>, cwd: string, resolver: ProjectionPathResolver): Record<string, any> {
	const rawPath = typeof input.path === "string" ? input.path : "";
	const pathInfo = resolver(rawPath, cwd);
	const edits = Array.isArray(input.edits) ? input.edits : [];

	let hasChunkTruncated = false;
	const previews = edits.slice(0, EDIT_PREVIEW_MAX).map((edit: any) => {
		const oldText = edit && typeof edit.oldText === "string" ? edit.oldText : "";
		const newText = edit && typeof edit.newText === "string" ? edit.newText : "";
		const chunkTruncated =
			oldText.length > PROJECTION_PREVIEW_LENGTH || newText.length > PROJECTION_PREVIEW_LENGTH;
		if (chunkTruncated) hasChunkTruncated = true;
		return {
			old_preview: chunkTruncated ? oldText.slice(0, PROJECTION_PREVIEW_LENGTH) : oldText,
			new_preview: chunkTruncated ? newText.slice(0, PROJECTION_PREVIEW_LENGTH) : newText,
			truncated: chunkTruncated,
		};
	});

	const isGlobalTruncated = edits.length > EDIT_PREVIEW_MAX || hasChunkTruncated;

	return {
		...pathInfo,
		edits_count: edits.length,
		edits_preview: previews,
		content_truncated: isGlobalTruncated,
	};
}

function projectWriteInput(input: Record<string, any>, cwd: string, resolver: ProjectionPathResolver): Record<string, any> {
	const rawPath = typeof input.path === "string" ? input.path : "";
	const pathInfo = resolver(rawPath, cwd);
	const content = typeof input.content === "string" ? input.content : "";
	const byteLength = Buffer.byteLength(content, "utf8");
	const isTruncated = content.length > PROJECTION_PREVIEW_LENGTH;

	if (!isTruncated) {
		return {
			...pathInfo,
			byte_count: byteLength,
			content_preview: content,
			content_truncated: false,
		};
	}

	return {
		...pathInfo,
		byte_count: byteLength,
		preview_head: content.slice(0, PROJECTION_HEAD_LENGTH),
		preview_tail: content.slice(-PROJECTION_TAIL_LENGTH),
		content_truncated: true,
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

// ==============================================================
// Stage 1 独立健康状态追踪（ Module A / M6 对齐）
// ==============================================================

export type Stage1FailureReason = "timeout" | "exception" | "upstream_error" | "invalid_response";

export interface Stage1HealthStatus {
	status: "healthy" | "degraded";
	consecutiveFailures: number;
	totalFailures: number;
	lastFailureReason?: Stage1FailureReason;
	lastFailureAt?: number;
}

export const STAGE1_ESCALATE_THRESHOLD = 5;

export class StageHealthTracker {
	private status: "healthy" | "degraded" = "healthy";
	private consecutiveFailures = 0;
	private totalFailures = 0;
	private lastFailureReason?: Stage1FailureReason;
	private lastFailureAt?: number;
	private warnedDegraded = false;
	private escalated = false;

	public recordStage1Failure(reason: Stage1FailureReason): { transitioned: boolean; escalated: boolean } {
		this.consecutiveFailures++;
		this.totalFailures++;
		this.lastFailureReason = reason;
		this.lastFailureAt = Date.now();

		const transitioned = this.status === "healthy";
		this.status = "degraded";

		let escalated = false;
		if (this.consecutiveFailures >= STAGE1_ESCALATE_THRESHOLD && !this.escalated) {
			this.escalated = true;
			escalated = true;
		}

		return { transitioned, escalated };
	}

	public recordStage1Success(): void {
		this.consecutiveFailures = 0;
		this.status = "healthy";
		this.warnedDegraded = false;
		this.escalated = false;
	}

	public getStatus(): Stage1HealthStatus {
		return {
			status: this.status,
			consecutiveFailures: this.consecutiveFailures,
			totalFailures: this.totalFailures,
			lastFailureReason: this.lastFailureReason,
			lastFailureAt: this.lastFailureAt,
		};
	}

	public hasWarnedDegraded(): boolean {
		return this.warnedDegraded;
	}

	public setWarnedDegraded(warned: boolean): void {
		this.warnedDegraded = warned;
	}

	public hasEscalated(): boolean {
		return this.escalated;
	}

	public reset(): void {
		this.status = "healthy";
		this.consecutiveFailures = 0;
		this.totalFailures = 0;
		this.lastFailureReason = undefined;
		this.lastFailureAt = undefined;
		this.warnedDegraded = false;
		this.escalated = false;
	}
}

