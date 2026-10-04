/**
 * 审批弹窗展示控制符安全转义与清洗模块
 *
 * 核心目标：
 * 1. 防御终端注入：破坏不可信输入中的终端控制序列（ESC/CSI/OSC，如 \x1b[2J）；
 * 2. 捍卫宽度契约：将 \t 转义为 [TAB U+0009]，消除 visibleWidth 与终端 tab stop 算术不一致；
 * 3. 防范视觉欺骗：将 Bidi 覆盖字符（如 U+202E RLO）显式转义为 [BIDI U+202E RLO]；
 * 4. 坚持“所见即所审”：采用可见转义标记标注 Unicode 代码点；
 * 5. 保留换行语义：\n (U+000A) 原样保留，供换行与缩进逻辑处理。
 */

export interface SanitizedDetailResult {
	text: string;
	hasSanitized: boolean;
	escapedControlCount: number;
	escapedTabCount: number;
	escapedBidiCount: number;
}

const C0_CONTROL_NAMES: Record<number, string> = {
	0x00: "NUL",
	0x01: "SOH",
	0x02: "STX",
	0x03: "ETX",
	0x04: "EOT",
	0x05: "ENQ",
	0x06: "ACK",
	0x07: "BEL",
	0x08: "BS",
	0x0b: "VT",
	0x0c: "FF",
	0x0e: "SO",
	0x0f: "SI",
	0x10: "DLE",
	0x11: "DC1",
	0x12: "DC2",
	0x13: "DC3",
	0x14: "DC4",
	0x15: "NAK",
	0x16: "SYN",
	0x17: "ETB",
	0x18: "CAN",
	0x19: "EM",
	0x1a: "SUB",
	0x1c: "FS",
	0x1d: "GS",
	0x1e: "RS",
	0x1f: "US",
};

const BIDI_CONTROL_NAMES: Record<number, string> = {
	0x061c: "ALM",
	0x200e: "LRM",
	0x200f: "RLM",
	0x202a: "LRE",
	0x202b: "RLE",
	0x202c: "PDF",
	0x202d: "LRO",
	0x202e: "RLO",
	0x2066: "LRI",
	0x2067: "RLI",
	0x2068: "FSI",
	0x2069: "PDI",
};

const BIDI_CONTROL_REGEX = /\p{Bidi_Control}/u;

/**
 * 对审批弹窗中展示的不可信文本（如命令、路径、入参）执行安全转义
 *
 * @param raw 原始未清洗字符串
 * @returns 包含安全转义文本与统计指标的 SanitizedDetailResult
 */
export function sanitizeUntrustedDetail(raw: string): SanitizedDetailResult {
	if (typeof raw !== "string" || raw.length === 0) {
		return {
			text: typeof raw === "string" ? raw : String(raw ?? ""),
			hasSanitized: false,
			escapedControlCount: 0,
			escapedTabCount: 0,
			escapedBidiCount: 0,
		};
	}

	let escapedControlCount = 0;
	let escapedTabCount = 0;
	let escapedBidiCount = 0;
	const parts: string[] = [];

	for (const char of raw) {
		const code = char.codePointAt(0)!;

		// 1. 换行符（\n, U+000A）：原样保留，自然换行
		if (code === 0x0a) {
			parts.push("\n");
			continue;
		}

		// 2. 制表符（\t, U+0009）：转义为 [TAB U+0009]
		if (code === 0x09) {
			parts.push("[TAB U+0009]");
			escapedTabCount++;
			continue;
		}

		// 3. 回车符（\r, U+000D）：转义为 [CTRL U+000D CR]
		if (code === 0x0d) {
			parts.push("[CTRL U+000D CR]");
			escapedControlCount++;
			continue;
		}

		// 4. ESC 控制符（\x1b, U+001B）：转义为 [ESC U+001B]
		if (code === 0x1b) {
			parts.push("[ESC U+001B]");
			escapedControlCount++;
			continue;
		}

		// 5. 其他 C0 控制符（0x00–0x1F，排除已处理的 \t, \n, \r, \x1b）
		if (code >= 0x00 && code <= 0x1f) {
			const hex = code.toString(16).toUpperCase().padStart(4, "0");
			const name = C0_CONTROL_NAMES[code] || "CTRL";
			parts.push(`[CTRL U+${hex} ${name}]`);
			escapedControlCount++;
			continue;
		}

		// 6. DEL 字符（\x7f, U+007F）：转义为 [DEL U+007F]
		if (code === 0x7f) {
			parts.push("[DEL U+007F]");
			escapedControlCount++;
			continue;
		}

		// 7. C1 控制符（U+0080–U+009F）：转义为 [CTRL U+XXXX]
		if (code >= 0x80 && code <= 0x9f) {
			const hex = code.toString(16).toUpperCase().padStart(4, "0");
			parts.push(`[CTRL U+${hex}]`);
			escapedControlCount++;
			continue;
		}

		// 8. Bidi 控制字符（U+202E 等）：转义为 [BIDI U+XXXX <NAME>] 或 [BIDI U+XXXX]
		if (BIDI_CONTROL_NAMES[code] !== undefined) {
			const hex = code.toString(16).toUpperCase().padStart(4, "0");
			const name = BIDI_CONTROL_NAMES[code];
			parts.push(`[BIDI U+${hex} ${name}]`);
			escapedBidiCount++;
			continue;
		}
		if (BIDI_CONTROL_REGEX.test(char)) {
			const hex = code.toString(16).toUpperCase().padStart(4, "0");
			parts.push(`[BIDI U+${hex}]`);
			escapedBidiCount++;
			continue;
		}

		// 普通安全字符原样保留
		parts.push(char);
	}

	const hasSanitized = escapedControlCount > 0 || escapedTabCount > 0 || escapedBidiCount > 0;

	return {
		text: parts.join(""),
		hasSanitized,
		escapedControlCount,
		escapedTabCount,
		escapedBidiCount,
	};
}
