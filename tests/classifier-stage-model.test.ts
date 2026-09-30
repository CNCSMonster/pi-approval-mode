import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import approvalModeExtension, { resolveClassifierModel } from "../extensions/approval-mode.ts";

// 环境隔离：HOME 重定向，防本机真实用户规则/配置干扰钩子级断言（同批次隔离惯例）
process.env.HOME = mkdtempSync(join(tmpdir(), "pi-issue-0017-home-"));

test("resolveClassifierModel logic (① double default, ② single stage inheritance, ③ invalid fallback)", () => {
	const registry = {
		models: [
			{ provider: "llm-proxy-openai-chat", id: "gemini-3.8-flash-high-lp" },
			{ provider: "anthropic", id: "claude-3-opus" },
			{ provider: "google", id: "gemini-1.5-pro" },
		],
		find(p: string, id: string) { return this.models.find(m => m.provider === p && m.id === id) || null; },
		getAll() { return this.models; },
		hasConfiguredAuth() { return true; }
	};

	const defaultModel = { provider: "default", id: "default-model" };
	const ctx = { modelRegistry: registry, model: defaultModel, hasUI: false, ui: { notify: () => {} } } as any;

	// ① 双缺省（无分阶段键）解析走共享键→内置默认链；
	const res1 = resolveClassifierModel(ctx, undefined, undefined, false, "Stage 1");
	assert.strictEqual(res1.model.id, "gemini-3.8-flash-high-lp");
	assert.strictEqual(res1.fallbackReason, undefined);

	const res1Shared = resolveClassifierModel(ctx, undefined, "anthropic/claude-3-opus", false, "Stage 1");
	assert.strictEqual(res1Shared.model.id, "claude-3-opus");
	assert.strictEqual(res1Shared.fallbackReason, undefined);

	// ② 单阶段覆盖继承共享键（stage1 指定、stage2 继承）；
	const resS1 = resolveClassifierModel(ctx, "google/gemini-1.5-pro", "anthropic/claude-3-opus", false, "Stage 1");
	assert.strictEqual(resS1.model.id, "gemini-1.5-pro");

	const resS2 = resolveClassifierModel(ctx, undefined, "anthropic/claude-3-opus", false, "Stage 2");
	assert.strictEqual(resS2.model.id, "claude-3-opus");

	// ③ 无效配置值 → 回退 + 产生 fallbackReason；
	const resInvalid = resolveClassifierModel(ctx, "invalid/model", undefined, false, "Stage 1");
	assert.strictEqual(resInvalid.model.id, "gemini-3.8-flash-high-lp");
	assert.strictEqual(resInvalid.fallbackReason, "配置值 invalid/model 无效");
});

// ④ 失败语义 + ⑤ 记数语义 + 会话内告警，经 tool_call 钩子端到端验证。
// 设计要点：DenialTracker 阈值 consecutiveUnavailable=3，用例顺序刻意安排使每条断言
// 都能区分错误实现（详见各 case 注释）。
test("failure and metrics semantics via extension hooks (④, ⑤, 会话内告警)", async () => {
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const pi = {
		registerFlag: () => {},
		registerCommand: (name: string, def: any) => { commands[name] = def; },
		registerShortcut: () => {},
		getActiveTools: () => ["bash", "edit"],
		setActiveTools: () => {},
		on: (event: string, handler: Function) => { handlers[event] = handler; },
		appendEntry: () => {},
		// 强制 mode=auto（覆盖 /tmp/agent 共享配置里可能残留的 mode，保证跨测试文件确定性）
		getFlag: (name: string) => (name === "approval-mode" ? "auto" : undefined),
	};
	approvalModeExtension(pi as any);

	// ---- 可编程 mock 注册表 ----
	let stage1Auth = true; // 控制配置模型 test/stage1 的可用性（off → 解析链回退 ctx.model）
	let queue: Array<"throw" | "allow"> = []; // complete() 每次调用消费一项（两阶段共用模型，靠顺序区分）
	let calls = 0;
	const configuredModel = { provider: "test", id: "stage1" };
	const ctxModel = { provider: "ctx", id: "main" };
	const registry = {
		models: [configuredModel, ctxModel],
		find(p: string, id: string) {
			if (p === "test" && id === "stage1") return configuredModel;
			if (p === "ctx" && id === "main") return ctxModel;
			return null; // 内置默认 llm-proxy-* 一律找不到 → 落到 ctx.model
		},
		getAll() { return this.models; },
		hasConfiguredAuth(m: any) { return m.id === "stage1" ? stage1Auth : true; },
		complete: async () => {
			calls++;
			const act = queue.shift();
			if (act === "throw") throw new Error("model timeout");
			return { content: [{ type: "text", text: act === "allow" ? '{"shouldBlock": false}' : '{"shouldBlock": true}' }] };
		},
	};
	const notifySpy: string[] = [];
	const ctx: any = {
		modelRegistry: registry,
		model: ctxModel,
		hasUI: false,
		ui: {
			notify: () => {},
			select: async () => null,
			theme: { fg: (_c: string, t: string) => t },
			setStatus: () => {},
		},
		cwd: "/test",
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	await handlers["session_start"]({ reason: "start" }, ctx);
	// 归零分类器配置（清掉共享目录可能的残留）→ 设置共享模型（两阶段均解析 test/stage1）
	await commands["classifier-model"].handler("default", ctx);
	await commands["classifier-model"].handler("test/stage1", ctx);

	// ---- Case A（④）：stage1 运行失败 → 进 stage2 研判 → stage2 放行 ----
	queue = ["throw", "allow"]; calls = 0;
	const resA = await handlers["tool_call"]({ toolName: "bash", input: { command: "npm install" } }, ctx);
	assert.strictEqual(resA, undefined, "stage1 失败后应由 stage2 研判并放行");
	assert.strictEqual(calls, 2, "必须真实经过 stage1 → stage2 两次模型调用");
	assert.strictEqual(queue.length, 0);

	// ---- Case B（④）：两阶段均运行失败 → fail-closed（无头拒绝，原因注明失败阶段与原因）----
	queue = ["throw", "throw"]; calls = 0;
	const resB = await handlers["tool_call"]({ toolName: "bash", input: { command: "npm install" } }, ctx);
	assert.strictEqual(resB?.block, true, "stage2 运行失败必须 fail-closed 拒绝");
	assert.match(String(resB?.reason), /stage2_exception/, "拒绝原因须注明失败阶段与原因");
	assert.strictEqual(calls, 2);

	// ---- Case C/C2（会话内告警 + 解析链回退 + 去重）----
	// auth 关闭 → 配置值 test/stage1 无效 → 解析回退 ctx.model；hasUI 下两阶段各告警一次
	stage1Auth = false;
	queue = ["allow"]; calls = 0;
	const ctxUi = { ...ctx, hasUI: true, ui: { ...ctx.ui, notify: (m: string) => notifySpy.push(m) } };
	const resC = await handlers["tool_call"]({ toolName: "bash", input: { command: "npm install rimraf" } }, ctxUi);
	assert.strictEqual(resC, undefined, "无效配置应回退 ctx.model 并正常研判放行");
	assert.strictEqual(notifySpy.filter(m => m.includes("test/stage1")).length, 2, "Stage1/Stage2 各会话内告警一次（非仅 /reload）");

	queue = ["allow"];
	const resC2 = await handlers["tool_call"]({ toolName: "bash", input: { command: "npm install rimraf" } }, ctxUi);
	assert.strictEqual(resC2, undefined);
	assert.strictEqual(notifySpy.filter(m => m.includes("test/stage1")).length, 2, "相同配置失败的告警必须去重（防刷屏）");
	// 注：Case C 取到判定 → recordClassifierActive（重置 consecutiveUnavailable=0）。
	// 若重置缺失，Case D2 入口会提前触发熔断、拿不到 stage2_exception —— 由 D2 断言守护。

	// ---- Case D/D2（⑤）：恢复 auth，连续 stage2 失败各记 1 次 unavailable（1→2）----
	stage1Auth = true;
	queue = ["throw", "throw"]; calls = 0;
	const resD = await handlers["tool_call"]({ toolName: "bash", input: { command: "npm install express" } }, ctx);
	assert.strictEqual(resD?.block, true, "fail-closed");
	assert.match(String(resD?.reason), /stage2_exception/);

	queue = ["throw", "throw"];
	const resD2 = await handlers["tool_call"]({ toolName: "bash", input: { command: "npm install --save-dev typescript" } }, ctx);
	assert.strictEqual(resD2?.block, true, "unavailable=1 时仍应进入分类器");
	assert.match(String(resD2?.reason), /stage2_exception/, "守护 Case C 成功后的 active 重置（否则此处提前熔断）");

	// ---- Case D2b（⑤）：第三格失败前仍不熔断（入口 2 < 阈值 3，分类器仍接管）----
	queue = ["throw", "throw"];
	const resD2b = await handlers["tool_call"]({ toolName: "bash", input: { command: "npm install lodash" } }, ctx);
	assert.strictEqual(resD2b?.block, true, "fail-closed");
	assert.match(String(resD2b?.reason), /stage2_exception/, "入口 2 < 3 仍应进分类器（阈值锚定 M11）");

	// ---- Case D3（⑤/熔断现状）：连续不可用达到阈值 3 → 无头 loud 硬拦，计数须为 x3 ----
	queue = [];
	const resD3 = await handlers["tool_call"]({ toolName: "bash", input: { command: "npm audit fix" } }, ctx);
	assert.strictEqual(resD3?.block, true, "连续不可用熔断在无头下必须硬拦");
	assert.match(String(resD3?.reason), /classifier unavailable x3/, "熔断 reason 必须 loud 且计数正确");

	// 收尾：清理 /tmp/agent 共享配置，避免影响并行的其它测试文件
	await commands["classifier-model"].handler("default", ctx);
});

// ④ 交互侧：矩阵“失败语义”的转人审分支 + “连续不可用熔断→启发式（现状）”的 hasUI 分支
test("交互转人审 + 连续不可用交互降级启发式", async () => {
	const configuredModel = { provider: "test", id: "stage1" };
	const ctxModel = { provider: "ctx", id: "main" };
	const makeRegistry = () => ({
		models: [configuredModel, ctxModel],
		find(p: string, id: string) {
			return p === "test" && id === "stage1" ? configuredModel : p === "ctx" && id === "main" ? ctxModel : null;
		},
		getAll() { return this.models as any[]; },
		hasConfiguredAuth() { return true; },
		// 两阶段均运行失败（抛异常）→ 触发拍板① 的失败语义
		complete: async () => { throw new Error("model timeout"); },
	});
	const setup = async () => {
		const handlers: Record<string, any> = {};
		const commands: Record<string, any> = {};
		const pi = {
			registerFlag: () => {},
			registerCommand: (name: string, def: any) => { commands[name] = def; },
			registerShortcut: () => {},
			getActiveTools: () => ["bash", "edit"],
			setActiveTools: () => {},
			on: (event: string, handler: Function) => { handlers[event] = handler; },
			appendEntry: () => {},
			getFlag: (name: string) => (name === "approval-mode" ? "auto" : undefined),
		};
		approvalModeExtension(pi as any);
		let selectCalls = 0;
		const ctx: any = {
			modelRegistry: makeRegistry(),
			model: ctxModel,
			hasUI: true,
			ui: {
				notify: () => {},
				select: async () => { selectCalls++; return null; }, // null → 弹窗默认拒绝
				theme: { fg: (_c: string, t: string) => t },
				setStatus: () => {},
			},
			cwd: "/test",
			isProjectTrusted: () => true,
			sessionManager: { getBranch: () => [] },
		};
		await handlers["session_start"]({ reason: "start" }, ctx);
		await commands["classifier-model"].handler("default", ctx);
		await commands["classifier-model"].handler("test/stage1", ctx);
		return { handlers, ctx, select: () => selectCalls, reset: () => commands["classifier-model"].handler("default", ctx) };
	};

	// 实例 A：交互下 stage2 失败 → fail-closed 转人审（弹窗被触发，默认拒绝 → block）
	const a = await setup();
	const resA = await a.handlers["tool_call"]({ toolName: "bash", input: { command: "npm install" } }, a.ctx);
	assert.ok(a.select() >= 1, "交互必须弹出人审确认框（矩阵：stage2 失败 → 转人审）");
	assert.strictEqual(resA?.block, true);

	// 实例 B：连续三次 stage2 失败记满不可用（阈值 3，M11）→ 第四次不再进分类器，交互降级启发式直接放行
	const b = await setup();
	await b.handlers["tool_call"]({ toolName: "bash", input: { command: "npm install pkg-one" } }, b.ctx);
	await b.handlers["tool_call"]({ toolName: "bash", input: { command: "npm install pkg-two" } }, b.ctx);
	await b.handlers["tool_call"]({ toolName: "bash", input: { command: "npm install pkg-three" } }, b.ctx);
	const selectBefore = b.select();
	assert.ok(selectBefore >= 3, "前三次 stage2 失败均应转人审弹窗");
	const resB4 = await b.handlers["tool_call"]({ toolName: "bash", input: { command: "npm install pkg-four" } }, b.ctx);
	assert.strictEqual(resB4, undefined, "连续不可用（交互）应降级启发式并放行安全命令（现状）");
	assert.strictEqual(b.select(), selectBefore, "降级路径不应再弹分类器人审框");

	// 收尾：清理共享配置
	await a.reset();
	await b.reset();
});
