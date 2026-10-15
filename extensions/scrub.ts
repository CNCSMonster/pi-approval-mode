/**
 * 全字段深度脱敏管道（Scrub Pipeline）
 *
 * 采集、CAS 策略落盘、数据集导出、模型外发四处共用同一实现：
 * 1. 在对象序列化或外发之前，对整棵 JSON 树递归执行凭据脱敏；
 * 2. 替换形态为长度保持占位符 `[REDACTED:<class>:<原字节长度>]`——占位符本体定长语义，
 *    原字节长度保留在元数据中，供截断边界对齐与授权取证回溯（原文映射默认不落盘）；
 * 3. 管道幂等：对已脱敏文本重复执行不产生二次替换（外发前允许并需要二次脱敏）；
 * 4. 单字段扫描上限 50KB：超出先按字节边界截断再扫描，防止惰性全量正则在超大输入上
 *    耗费 CPU；截断标记由调用方决定是否随事件落盘。
 */

import { Buffer } from "node:buffer";

/** 单字段扫描长度上限（字节）。超出先截断再扫描。 */
export const SCRUB_FIELD_SCAN_CAP_BYTES = 50 * 1024;

/** 凭据类别（占位符 <class> 取值，也是重放与审计时的归因口径）。 */
export type ScrubClass =
	| "private-key"
	| "env-value"
	| "uri-credential"
	| "api-token"
	| "aws-access-key"
	| "jwt";

/** 单次替换记录。original 供可选的原文映射表使用（默认不落盘）。 */
export interface ScrubHit {
	class: ScrubClass;
	original: string;
	placeholder: string;
}

export interface ScrubTextResult {
	text: string;
	hits: ScrubHit[];
	truncated: boolean;
}

export interface ScrubTreeResult<T> {
	value: T;
	hits: ScrubHit[];
	truncated: boolean;
}

// —— 模式库 ——
// 执行序：私钥块与行级上下文（.env、URI）先行，可给出更精确的类别归因；独立 token 样式随后兜底。
// 行级匹配不使用可跨行的字符类（换行不参与凭据体，避免吞并相邻行结构）。

/** 私钥证书块：匹配至首个 END（惰性），整体替换。 */
const PRIVATE_KEY_RE = /-----BEGIN[\s\S]*?-----END/g;

/** .env 键值对：键名含 key/token/secret/password（i 覆盖混合大小写），仅替换值段。 */
const ENV_KV_RE = /^([ \t]*[A-Za-z_]*(?:key|token|secret|password)[A-Za-z_]*[ \t]*=[ \t]*)([^\r\n]+)$/gim;

/** URI 密码凭据：scheme://user:password@host 的 password 段替换。 */
const URI_CRED_RE = /(:\/\/[^:\r\n]+:)([^@\r\n]+)(@)/g;

const API_TOKEN_RE = /(?:sk|key|token|ghp|gho|xoxb)-[a-zA-Z0-9_-]{16,}/g;
const AWS_KEY_RE = /\b(AKIA|ABIA|ACCA)[A-Z0-9]{16}\b/g;
const JWT_RE = /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;

/** 占位符全形：`[REDACTED:<class>:<字节数>]`。 */
const PLACEHOLDER_RE = /^\[REDACTED:[a-z0-9-]+:\d+\]$/;

/** 判断某段文本是否已是占位符本体（幂等护栏：仅跳过"整段即占位符"的值段，含占位符的普通文本照常扫描）。 */
function isPlaceholder(text: string): boolean {
	return PLACEHOLDER_RE.test(text);
}

/** 生成长度保持占位符：元数据保留原文本的 UTF-8 字节数。 */
function makePlaceholder(cls: ScrubClass, original: string): string {
	return `[REDACTED:${cls}:${Buffer.byteLength(original, "utf8")}]`;
}

/** 按 UTF-8 字节边界截断（不切断多字节字符）。截断工具供采集等上层模块复用。 */
export function truncateToBytes(input: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(input, "utf8") <= maxBytes) {
		return { text: input, truncated: false };
	}
	let bytes = 0;
	let end = 0;
	for (const ch of input) {
		const chBytes = Buffer.byteLength(ch, "utf8");
		if (bytes + chBytes > maxBytes) break;
		bytes += chBytes;
		end += ch.length;
	}
	return { text: input.slice(0, end), truncated: true };
}

function scrubCore(input: string): { text: string; hits: ScrubHit[] } {
	const hits: ScrubHit[] = [];
	let text = input;

	text = text.replace(PRIVATE_KEY_RE, (match) => {
		const placeholder = makePlaceholder("private-key", match);
		hits.push({ class: "private-key", original: match, placeholder });
		return placeholder;
	});

	text = text.replace(ENV_KV_RE, (match, keyPart: string, value: string) => {
		if (isPlaceholder(value)) return match;
		const placeholder = makePlaceholder("env-value", value);
		hits.push({ class: "env-value", original: value, placeholder });
		return `${keyPart}${placeholder}`;
	});

	text = text.replace(URI_CRED_RE, (match, prefix: string, password: string, suffix: string) => {
		if (isPlaceholder(password)) return match;
		const placeholder = makePlaceholder("uri-credential", password);
		hits.push({ class: "uri-credential", original: password, placeholder });
		return `${prefix}${placeholder}${suffix}`;
	});

	text = text.replace(API_TOKEN_RE, (match) => {
		const placeholder = makePlaceholder("api-token", match);
		hits.push({ class: "api-token", original: match, placeholder });
		return placeholder;
	});

	text = text.replace(AWS_KEY_RE, (match) => {
		const placeholder = makePlaceholder("aws-access-key", match);
		hits.push({ class: "aws-access-key", original: match, placeholder });
		return placeholder;
	});

	text = text.replace(JWT_RE, (match) => {
		const placeholder = makePlaceholder("jwt", match);
		hits.push({ class: "jwt", original: match, placeholder });
		return placeholder;
	});

	return { text, hits };
}

/** 对单个字符串执行脱敏（先按 50KB 上限截断，再扫描替换）。 */
export function scrubText(input: string): ScrubTextResult {
	const capped = truncateToBytes(input, SCRUB_FIELD_SCAN_CAP_BYTES);
	const scrubbed = scrubCore(capped.text);
	return { text: scrubbed.text, hits: scrubbed.hits, truncated: capped.truncated };
}

function scrubNode(node: unknown, hits: ScrubHit[]): { value: unknown; truncated: boolean } {
	if (typeof node === "string") {
		const result = scrubText(node);
		hits.push(...result.hits);
		return { value: result.text, truncated: result.truncated };
	}
	if (Array.isArray(node)) {
		let truncated = false;
		const value = node.map((item) => {
			const r = scrubNode(item, hits);
			truncated = truncated || r.truncated;
			return r.value;
		});
		return { value, truncated };
	}
	if (node !== null && typeof node === "object") {
		let truncated = false;
		const value: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
			const r = scrubNode(item, hits);
			truncated = truncated || r.truncated;
			value[key] = r.value;
		}
		return { value, truncated };
	}
	return { value: node, truncated: false };
}

/** 对整棵 JSON 树递归脱敏（返回拷贝，不修改入参）。对象键名不参与扫描，结构完整性优先。 */
export function scrubJsonTree<T>(value: T): ScrubTreeResult<T> {
	const hits: ScrubHit[] = [];
	const result = scrubNode(value, hits);
	return { value: result.value as T, hits, truncated: result.truncated };
}
