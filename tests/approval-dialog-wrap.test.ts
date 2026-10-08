import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import approvalModeExtension, { wrapDialogLine } from "../extensions/approval-mode.ts";

/** 去掉缩进与空白后的内容指纹：用于证明换行过程零内容丢失（截断会丢字符） */
function fingerprint(s: string): string {
	return stripTerminalSequences(s).replace(/\s+/g, "");
}

test(" 弹窗渲染源码不再使用 truncateToWidth 截断", () => {
	const src = readFileSync(new URL("../extensions/approval-mode.ts", import.meta.url), "utf8");
	assert.ok(!src.includes("truncateToWidth"), "审批弹窗渲染路径不得再调用 truncateToWidth");
	assert.ok(src.includes("wrapDialogLine(str, safeWidth"), "render() 应改用 wrapDialogLine 自适应换行");
});

test(" 超宽命令行按视口换行完整展示（不截断、不丢内容）", () => {
	const cmd =
		"git -C /home/user/projects/some-very-long-repository-name push origin main --force-with-lease && echo pushed && ls -la /tmp";
	const width = 60;
	const lines = wrapDialogLine(cmd, width, "    ");

	assert.ok(lines.length > 1, "超宽命令应折成多行");
	for (const l of lines) {
		assert.ok(visibleWidth(l) <= width, `行超宽(${visibleWidth(l)} > ${width}): ${JSON.stringify(l)}`);
	}
	assert.ok(
		!lines.some((l) => stripTerminalSequences(l).includes("...")),
		"换行输出不应出现省略号截断符",
	);
	// 内容零丢失：折叠空白后与原命令逐字符一致
	assert.equal(fingerprint(lines.join("")), fingerprint(cmd));
	// 续行缩进对齐到内容起始列
	for (const l of lines.slice(1)) {
		assert.ok(stripTerminalSequences(l).startsWith("    "), `续行应保留 4 空格缩进: ${JSON.stringify(l)}`);
	}
});

test(" 无词边界的超长命令按字符断行（逐字符零丢失）", () => {
	// 命令尾部是一整段无空格 token，正是 shell 长路径 / 长参数的典型形态
	const cmd = "dd if=/dev/zero of=/dev/sda bs=1M count=1024 conv=fsync,notrunc " + "x".repeat(120);
	const width = 40;
	const lines = wrapDialogLine(cmd, width, "    ");

	assert.ok(lines.length > 3, "无空格超长 token 必须被按字符切开");
	for (const l of lines) {
		assert.ok(visibleWidth(l) <= width, `行超宽(${visibleWidth(l)} > ${width}): ${JSON.stringify(l)}`);
	}
	assert.equal(fingerprint(lines.join("")), fingerprint(cmd));
});

test(" ANSI 样式跨行保持（换行处不丢色）", () => {
	const styled =
		"\x1b[38;5;123m" +
		"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho" +
		"\x1b[0m";
	const lines = wrapDialogLine(styled, 24, "  ");

	assert.ok(lines.length > 2, "应折成多行");
	for (const l of lines.slice(1)) {
		assert.ok(l.includes("\x1b[38;5;123m"), `续行应继承活动 ANSI 颜色: ${JSON.stringify(l)}`);
	}
	assert.equal(fingerprint(lines.join("")), fingerprint(styled));
});

test(" 边框行与空行原样输出（宽度恰好等于视口不折行）", () => {
	const border = "─".repeat(60);
	assert.deepEqual(wrapDialogLine(border, 60, ""), [border]);
	assert.deepEqual(wrapDialogLine("", 60, "  "), ["  "]);
});

test(" 内容自带换行符时逐行各自换行并加缩进", () => {
	const lines = wrapDialogLine("first line here\nsecond line", 40, "  ");
	assert.deepEqual(lines, ["  first line here", "  second line"]);
});

test(" 中文内容按显示宽度（CJK 双宽）换行", () => {
	const text = "准备执行命令：删除工作区内所有未跟踪文件并强制还原已跟踪文件的修改内容";
	const width = 30;
	const lines = wrapDialogLine(text, width, "    ");

	assert.ok(lines.length > 1, "中文长句应折行");
	for (const l of lines) {
		assert.ok(visibleWidth(l) <= width, `行超宽(${visibleWidth(l)} > ${width}): ${JSON.stringify(l)}`);
	}
	assert.equal(fingerprint(lines.join("")), fingerprint(text));
});

// ============================================================
// 端到端：真实审批弹窗（TUI 自定义组件）渲染 → 断言命令完整可见
// ============================================================

async function setupTuiManualDialog(): Promise<{
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
		getActiveTools: () => ["bash", "edit"],
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
			theme: { fg: (_c: string, t: string) => t },
			setStatus: () => {},
			// 捕获真实审批面板组件：工厂返回后立即视同用户按 Esc 拒绝，让 tool_call 链路走完
			custom: async (factory: (tui: any, theme: any, kb: any, done: (r: any) => void) => any) => {
				const tui = { requestRender: () => {} };
				const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
				rendered = factory(tui, theme, undefined, () => {});
				return "block";
			},
		},
		cwd: mkdtempSync(join(tmpdir(), "pi-issue-0035-cwd-")),
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	await handlers["session_start"]({ reason: "start" }, ctx);
	await commands["approval-mode"].handler("manual", ctx); // manual：bash 一律进人审弹窗
	return { handlers, commands, ctx, getRendered: () => rendered };
}

test(" 端到端：manual 弹窗在 80 列视口完整展示超长命令", async () => {
	const h = await setupTuiManualDialog();
	const longCmd =
		"sudo docker run --rm -v /home/user/projects/long-project-name:/app -e NODE_ENV=production --name some-long-container-name node:22-slim sh -c 'npm ci && npm run build && echo finished'";
	await h.handlers["tool_call"]({ toolName: "bash", input: { command: longCmd } }, h.ctx);

	const comp = h.getRendered();
	assert.ok(comp && typeof comp.render === "function", "应捕获到审批面板组件");

	const width = 80;
	const lines = comp.render(width);
	assert.ok(lines.length > 12, "弹窗应有多行（含换行后的命令）");
	for (const l of lines) {
		assert.ok(visibleWidth(l) <= width, `第 ${lines.indexOf(l) + 1} 行超宽(${visibleWidth(l)}): ${JSON.stringify(l)}`);
	}
	// 关键验收：完整命令在弹窗里逐字符可见（截断实现必然在此失败）
	assert.ok(
		fingerprint(lines.join("")).includes(fingerprint(longCmd)),
		"弹窗内容必须包含完整命令（无省略截断）",
	);
});

test(" 端到端：窄视口 40 列同样完整展示且不溢出", async () => {
	const h = await setupTuiManualDialog();
	const longCmd = "find /var/log -type f -name '*.log' -mtime +30 -exec rm -f {} \\; && echo cleanup-done && exit 0";
	await h.handlers["tool_call"]({ toolName: "bash", input: { command: longCmd } }, h.ctx);

	const comp = h.getRendered();
	const width = 40;
	const lines = comp.render(width);
	for (const l of lines) {
		assert.ok(visibleWidth(l) <= width, `第 ${lines.indexOf(l) + 1} 行超宽(${visibleWidth(l)}): ${JSON.stringify(l)}`);
	}
	assert.ok(
		fingerprint(lines.join("")).includes(fingerprint(longCmd)),
		"窄视口下完整命令仍应逐字符可见",
	);
	// 选项区版式：编号前缀仍在首行、续行对齐（不因换行错位）
	const optionLine = lines.find((l: string) => l.includes("允许本次执行"));
	assert.ok(optionLine, "应渲染出审批选项");
});
