/**
 * Stage 1 分类器改用 pi 原生 classifier 模型目录与 classify API。
 *
 * 覆盖面：
 * - stage1-classifier.ts 纯逻辑（Context 构建 / Result 判读 / 超时竞速 / 目录查找）；
 * - resolveClassifierModel 的 classifier 目录回退与 Stage 2 allowClassifier 防护；
 * - /classifier-model 校验（--stage1 接受 classifier，--stage2/--both 拒绝）与动态补全；
 * - 两阶段状态机经 registry.classify() 的端到端派发（放行 / 上浮 Stage 2 / 四类失败归因）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试环境隔离（与 issue-0036 相同模式）：HOME 与 PI_CODING_AGENT_DIR 双双指向临时目录
const tempBase = mkdtempSync(join(tmpdir(), "pi-issue-0045-"));
const agentDir = join(tempBase, "agent");
process.env.HOME = tempBase;
process.env.USERPROFILE = tempBase;
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });

import {
	buildStage1ClassifierContext,
	buildStage1StateText,
	interpretStage1Result,
	classifyStage1,
	findClassifierModel,
	STAGE1_QUESTION_KEY,
	DEFAULT_SHOULD_BLOCK_THRESHOLD,
} from "../extensions/stage1-classifier.ts";
import approvalModeExtension, { resolveClassifierModel } from "../extensions/approval-mode.ts";

test.after(() => {
	rmSync(tempBase, { recursive: true, force: true });
});

const classifierModel = {
	type: "classifier",
	id: "typesafe/jev-1.13",
	name: "TypeSafe: Jev 1.13",
	api: "typesafe-system-one",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32000,
};

function makeCatalogRegistry(opts?: { auth?: (m: any) => boolean; noNativeMethods?: boolean }): any {
	const chatModels = [
		{ provider: "test", id: "stage2-model", name: "Stage 2 Model" },
		{ provider: "test", id: "main-model", name: "Main Model" },
	];
	const auth = opts?.auth ?? ((m: any) => m?.id !== "noauth");
	const reg: any = {
		find: (p: string, id: string) => chatModels.find((m) => m.provider === p && m.id === id) ?? null,
		getAll: () => chatModels,
		hasConfiguredAuth: auth,
	};
	if (!opts?.noNativeMethods) {
		reg.findOfType = (type: string, provider: string, id: string) =>
			type === "classifier" && provider === "openrouter" && id === "typesafe/jev-1.13"
				? classifierModel
				: undefined;
		reg.getModelsOfType = (type: string) => (type === "classifier" ? [classifierModel] : chatModels);
	}
	return reg;
}

function writeAgentConfig(cfg: Record<string, any>): void {
	writeFileSync(join(agentDir, "approval-config.json"), JSON.stringify(cfg, null, 2), "utf-8");
}

function readAgentConfig(): any {
	return JSON.parse(readFileSync(join(agentDir, "approval-config.json"), "utf-8"));
}

// =========================================================================
// 1. stage1-classifier 纯逻辑
// =========================================================================

test("stage1-classifier: buildStage1ClassifierContext 形态对齐官方 examples/extensions/jev-router.ts", () => {
	const ctx = buildStage1ClassifierContext("Conversation Transcript:\nhi\nTool: bash");
	assert.strictEqual(typeof ctx.state.prompt, "string");
	assert.ok(ctx.state.prompt.includes("Tool: bash"));

	const q = ctx.questions[STAGE1_QUESTION_KEY];
	assert.strictEqual(STAGE1_QUESTION_KEY, "shouldBlock");
	assert.strictEqual(q.type, "bool");
	assert.ok(q.instructions.includes("blocked for human approval"));
	assert.strictEqual(typeof q.criteria.true, "string");
	assert.strictEqual(typeof q.criteria.false, "string");
	assert.ok(q.criteria.true.length > 0);
	assert.ok(q.criteria.false.length > 0);

	// 两次构建互不共享可变引用（criteria 每次浅拷贝）
	const ctx2 = buildStage1ClassifierContext("x");
	assert.notStrictEqual(ctx.questions, ctx2.questions);
	assert.notStrictEqual(ctx.questions[STAGE1_QUESTION_KEY].criteria, ctx2.questions[STAGE1_QUESTION_KEY].criteria);
});

test("stage1-classifier: buildStage1StateText 评测口径（空会话占位与空入参回退）", () => {
	const full = buildStage1StateText("bash", { command: "rm -rf /" }, "user: clean the disk");
	assert.ok(full.includes("user: clean the disk"));
	assert.ok(full.includes("Tool: bash"));
	assert.ok(full.includes("rm -rf /"));

	const empty = buildStage1StateText("read", null, "");
	assert.ok(empty.includes("(no previous context)"));
	assert.ok(empty.includes("{}"));
});

test("stage1-classifier: interpretStage1Result 阈值判定（0.5 边界与自定义阈值）", () => {
	assert.strictEqual(DEFAULT_SHOULD_BLOCK_THRESHOLD, 0.5);

	const allow = interpretStage1Result(stopResult(0.01));
	assert.strictEqual(allow.ok, true);
	assert.strictEqual(allow.shouldBlock, false);
	assert.strictEqual(allow.probability, 0.01);

	assert.strictEqual(interpretStage1Result(stopResult(0.49)).shouldBlock, false);
	assert.strictEqual(interpretStage1Result(stopResult(0.5)).shouldBlock, true, "阈值应为 >=（含边界）");
	assert.strictEqual(interpretStage1Result(stopResult(0.99)).shouldBlock, true);

	// 自定义阈值
	assert.strictEqual(interpretStage1Result(stopResult(0.85), 0.9).shouldBlock, false);
	assert.strictEqual(interpretStage1Result(stopResult(0.95), 0.9).shouldBlock, true);
});

function stopResult(probability: number): any {
	return { stopReason: "stop", answers: { [STAGE1_QUESTION_KEY]: { type: "bool", probability } } };
}

test("stage1-classifier: interpretStage1Result 失败归因全分支", () => {
	// null（竞速超时兜底）→ timeout
	assert.strictEqual(interpretStage1Result(null).failure, "timeout");
	// aborted → timeout
	assert.strictEqual(interpretStage1Result({ stopReason: "aborted" }).failure, "timeout");
	// stopReason=error → upstream_error
	const up = interpretStage1Result({ stopReason: "error", errorMessage: "HTTP 502" });
	assert.strictEqual(up.failure, "upstream_error");
	assert.strictEqual(up.errorMessage, "HTTP 502");
	// stopReason=stop 但携带 errorMessage → upstream_error（消息兜底文案）
	const up2 = interpretStage1Result({ stopReason: "stop", errorMessage: "x" });
	assert.strictEqual(up2.failure, "upstream_error");
	assert.strictEqual(up2.errorMessage, "x");
	const up3 = interpretStage1Result({ stopReason: "error" });
	assert.strictEqual(up3.errorMessage, "unknown upstream error");
	// answers 缺失 / 键缺失 / 类型非 bool / 概率非数值 → invalid_response
	assert.strictEqual(interpretStage1Result({ stopReason: "stop" }).failure, "invalid_response");
	assert.strictEqual(interpretStage1Result({ stopReason: "stop", answers: {} }).failure, "invalid_response");
	assert.strictEqual(
		interpretStage1Result({ stopReason: "stop", answers: { shouldBlock: { type: "choice", probability: 0.1 } } }).failure,
		"invalid_response",
	);
	assert.strictEqual(
		interpretStage1Result({ stopReason: "stop", answers: { shouldBlock: { type: "bool", probability: "high" } } }).failure,
		"invalid_response",
	);
});

test("stage1-classifier: classifyStage1 成功路径与上下文透传", async () => {
	let seen: any = null;
	const reg = {
		classify: async (model: any, context: any, options: any) => {
			seen = { model, context, options };
			return stopResult(0.02);
		},
	};
	const out = await classifyStage1(reg, classifierModel, "Conversation Transcript:\nhi\nTool: bash", 1000);
	assert.strictEqual(out.ok, true);
	assert.strictEqual(out.shouldBlock, false);

	// 透传给原生 classify 的契约：model、bool 问题上下文、AbortSignal
	assert.strictEqual(seen.model, classifierModel);
	assert.strictEqual(seen.context.questions.shouldBlock.type, "bool");
	assert.ok(seen.context.state.prompt.includes("Tool: bash"));
	assert.ok(seen.options.signal instanceof AbortSignal);
	assert.strictEqual(seen.options.signal.aborted, false);

	// 阈值透传
	const regHigh = { classify: async () => stopResult(0.85) };
	const gated = await classifyStage1(regHigh, classifierModel, "s", 1000, 0.9);
	assert.strictEqual(gated.shouldBlock, false);
});

test("stage1-classifier: classifyStage1 异常归因（exception / abort 抛错 / 竞速超时）", async () => {
	// 1. 意外抛错 → exception
	const boom = await classifyStage1(
		{
			classify: async () => {
				throw new Error("boom");
			},
		},
		classifierModel,
		"s",
		1000,
	);
	assert.strictEqual(boom.ok, false);
	assert.strictEqual(boom.failure, "exception");
	assert.strictEqual(boom.errorMessage, "boom");

	// 2. 信号未中止但抛 AbortError → timeout
	const abortThrow = await classifyStage1(
		{
			classify: async () => {
				const e = new Error("aborted");
				e.name = "AbortError";
				throw e;
			},
		},
		classifierModel,
		"s",
		1000,
	);
	assert.strictEqual(abortThrow.failure, "timeout");

	// 3. 挂起且响应 abort 的请求 → 超时中止 + timeout
	let sawAbort = false;
	const hang = await classifyStage1(
		{
			classify: (_m: any, _c: any, options: any) =>
				new Promise((_, reject) => {
					options.signal.addEventListener("abort", () => {
						sawAbort = true;
						const e = new Error("aborted");
						e.name = "AbortError";
						reject(e);
					});
				}),
		},
		classifierModel,
		"s",
		60,
	);
	assert.strictEqual(hang.failure, "timeout");
	assert.strictEqual(sawAbort, true, "超时必须真实触发 AbortController 中止底层请求");

	// 4. 永不 settle 的实现 → 竞速兜底收敛 timeout（不吊死会话）
	const dead = await classifyStage1({ classify: () => new Promise(() => {}) }, classifierModel, "s", 60);
	assert.strictEqual(dead.failure, "timeout");
});

test("stage1-classifier: findClassifierModel 目录查找（首斜杠切分 / 全量 ID 扫描 / 认证门禁）", () => {
	const reg = makeCatalogRegistry();

	// 1. provider/id 形态 → findOfType
	const full = findClassifierModel(reg, "openrouter/typesafe/jev-1.13");
	assert.strictEqual(full, classifierModel);

	// 2. 目录裸 ID（id 自带斜杠，首斜杠切分必然失败）→ getModelsOfType 全量扫描
	const bare = findClassifierModel(reg, "typesafe/jev-1.13");
	assert.strictEqual(bare, classifierModel);

	// 3. provider/id 全量扫描兜底（仅 getModelsOfType、无 findOfType 的目录）
	const scanOnly = {
		hasConfiguredAuth: () => true,
		getModelsOfType: () => [classifierModel],
	};
	assert.strictEqual(findClassifierModel(scanOnly, "openrouter/typesafe/jev-1.13"), classifierModel);

	// 4. 未配置认证 → null
	const noAuth = makeCatalogRegistry({ auth: () => false });
	assert.strictEqual(findClassifierModel(noAuth, "openrouter/typesafe/jev-1.13"), null);

	// 5. 无原生方法的旧版 pi / 测试 mock → null（不得抛错）
	assert.strictEqual(findClassifierModel({ find: () => null, getAll: () => [] }, "typesafe/jev-1.13"), null);

	// 6. 空入参
	assert.strictEqual(findClassifierModel(reg, ""), null);
	assert.strictEqual(findClassifierModel(null, "typesafe/jev-1.13"), null);

	// 7. findOfType 抛错 → 回退全量扫描
	const throwReg = {
		hasConfiguredAuth: () => true,
		findOfType: () => {
			throw new Error("no native");
		},
		getModelsOfType: () => [classifierModel],
	};
	assert.strictEqual(findClassifierModel(throwReg, "openrouter/typesafe/jev-1.13"), classifierModel);

	// 8. getModelsOfType 抛错 → null
	const throwScan = {
		hasConfiguredAuth: () => true,
		findOfType: () => undefined,
		getModelsOfType: () => {
			throw new Error("no scan");
		},
	};
	assert.strictEqual(findClassifierModel(throwScan, "typesafe/jev-1.13"), null);

	// 9. 认证检查抛错 → 视为无认证
	const throwAuth = makeCatalogRegistry({
		auth: () => {
			throw new Error("auth broken");
		},
	});
	assert.strictEqual(findClassifierModel(throwAuth, "typesafe/jev-1.13"), null);
});

// =========================================================================
// 2. resolveClassifierModel：classifier 目录回退与 Stage 2 防护
// =========================================================================

test("resolveClassifierModel: classifier 目录回退与 allowClassifier 防护", () => {
	const ctx: any = { modelRegistry: makeCatalogRegistry(), model: { provider: "anthropic", id: "main-model" } };

	// 1. provider/id 全引用（chat find 未命中 → classifier findOfType）
	const r1 = resolveClassifierModel(ctx, "openrouter/typesafe/jev-1.13", undefined, false, "Stage 1");
	assert.strictEqual(r1.model.type, "classifier");
	assert.strictEqual(r1.label, "openrouter/typesafe/jev-1.13");
	assert.strictEqual(r1.fallbackReason, undefined);

	// 2. 目录裸 ID（首斜杠切分失败 → 全量扫描）
	const r2 = resolveClassifierModel(ctx, "typesafe/jev-1.13", undefined, false, "Stage 1");
	assert.strictEqual(r2.model.type, "classifier");
	assert.strictEqual(r2.label, "openrouter/typesafe/jev-1.13");

	// 3. Stage 2 防护：allowClassifier=false → 跳过 classifier，回退主模型（拍板 #5）
	const r3 = resolveClassifierModel(ctx, "openrouter/typesafe/jev-1.13", undefined, false, "Stage 2", false);
	assert.strictEqual(r3.model.id, "main-model");
	assert.ok(r3.fallbackReason, "classifier 配置在 Stage 2 必须带出回退原因");

	// 4. 未认证 classifier → 回退
	const noAuthCtx: any = {
		modelRegistry: makeCatalogRegistry({ auth: () => false }),
		model: { provider: "anthropic", id: "main-model" },
	};
	const r4 = resolveClassifierModel(noAuthCtx, "openrouter/typesafe/jev-1.13", undefined, false, "Stage 1");
	assert.strictEqual(r4.model.id, "main-model");
});

// =========================================================================
// 3. /classifier-model 校验（flag 感知）与动态补全
// =========================================================================

test("/classifier-model: --stage1 接受 classifier 模型，--stage2/--both 拒绝", async () => {
	writeAgentConfig({});
	const h = await setupHarness({ registry: makeCatalogRegistry() });

	// 1. --stage1 设置 classifier → 保存成功
	await h.commands["classifier-model"].handler("openrouter/typesafe/jev-1.13".replace(/^/, "--stage1 "), h.ctx);
	let last = h.notices[h.notices.length - 1];
	assert.strictEqual(last.level, "info");
	assert.match(last.msg, /已保存分类器模型配置/);
	assert.strictEqual(readAgentConfig().classifierStage1Model, "openrouter/typesafe/jev-1.13");

	// 2. --stage2 设置 classifier → 拒绝且不落盘
	await h.commands["classifier-model"].handler("--stage2 openrouter/typesafe/jev-1.13", h.ctx);
	last = h.notices[h.notices.length - 1];
	assert.strictEqual(last.level, "error");
	assert.match(last.msg, /仅支持 --stage1/);
	assert.strictEqual(readAgentConfig().classifierStage2Model, undefined);

	// 3. --both 设置 classifier → 拒绝（--both 含 Stage 2 语义）
	await h.commands["classifier-model"].handler("--both openrouter/typesafe/jev-1.13", h.ctx);
	last = h.notices[h.notices.length - 1];
	assert.strictEqual(last.level, "error");
	assert.match(last.msg, /仅支持 --stage1/);
	assert.strictEqual(readAgentConfig().classifierModel, undefined);

	// 4. 普通 chat 模型三 flag 均可（回归保护）
	await h.commands["classifier-model"].handler("--stage2 test/stage2-model", h.ctx);
	last = h.notices[h.notices.length - 1];
	assert.strictEqual(last.level, "info");
	assert.strictEqual(readAgentConfig().classifierStage2Model, "test/stage2-model");
});

test("/classifier-model 补全: 动态枚举 classifier 目录（仅 --stage1）与生效标记", async () => {
	writeAgentConfig({});
	const h = await setupHarness({ registry: makeCatalogRegistry() });
	const getCompletions = h.commands["classifier-model"].getArgumentCompletions;

	// 1. --stage1 空前缀：chat + classifier 全量
	let items = getCompletions("--stage1 ");
	assert.ok(Array.isArray(items));
	const jev = items.find((it: any) => it.label === "openrouter/typesafe/jev-1.13");
	assert.ok(jev, "classifier 模型必须出现在 --stage1 补全中");
	assert.match(jev.description, /System One 专职分类器/);
	assert.ok(!jev.description.includes("✓"), "未设置前不应有生效标记");

	// 2. 前缀过滤
	items = getCompletions("--stage1 openrouter/typesafe/jev");
	assert.strictEqual(items?.length, 1);
	assert.strictEqual(items[0].label, "openrouter/typesafe/jev-1.13");

	// 3. --stage2 补全不含 classifier（Stage 2 恒为通用 LLM）
	items = getCompletions("--stage2 ");
	assert.ok(Array.isArray(items));
	assert.ok(!items.some((it: any) => it.label.includes("typesafe/jev")));

	// 4. 设置为生效模型后带 ✓ 标记
	await h.commands["classifier-model"].handler("--stage1 openrouter/typesafe/jev-1.13", h.ctx);
	items = getCompletions("--stage1 ");
	const jevNow = items.find((it: any) => it.label === "openrouter/typesafe/jev-1.13");
	assert.match(jevNow.description, /✓ 当前生效/);

	// 5. getModelsOfType 抛错时补全不崩（chat 部分仍可用）
	const h2 = await setupHarness({
		registry: {
			...makeCatalogRegistry(),
			getModelsOfType: () => {
				throw new Error("catalog broken");
			},
		},
	});
	const items2 = h2.commands["classifier-model"].getArgumentCompletions("--stage1 ");
	assert.ok(Array.isArray(items2));
	assert.strictEqual(items2.length, 2, "chat 模型补全不受 classifier 目录异常影响");
});

// =========================================================================
// 4. 端到端：两阶段状态机经 registry.classify() 派发
// =========================================================================

test("e2e: Stage 1 classifier 派发（快速放行 / 上浮 Stage 2 / 失败归因与健康度）", async () => {
	writeAgentConfig({
		classifierStage1Model: "openrouter/typesafe/jev-1.13",
		classifierStage2Model: "test/stage2-model",
	});
	const h = await setupHarness({ registry: makeCatalogRegistry() });

	// 1. 快速放行（probability 0.01 < 0.5）→ 不触碰 Stage 2
	h.setClassify(async () => stopResult(0.01));
	const r1 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "ls -la" } }, h.ctx);
	assert.strictEqual(r1, undefined, "Stage 1 放行必须直接通过");
	assert.strictEqual(h.calls.classify, 1);
	assert.strictEqual(h.calls.complete, 0, "放行场景不得调用 Stage 2");
	// 派发上下文包含待执行调用
	assert.ok(h.lastClassifyArgs().context.state.prompt.includes("ls -la"));
	assert.ok(h.lastClassifyArgs().context.state.prompt.includes("Tool: bash"));
	assert.ok(h.lastClassifyArgs().options.signal instanceof AbortSignal);

	// 2. 上浮（probability 0.99 >= 0.5）→ Stage 2 复核
	h.setClassify(async () => stopResult(0.99));
	const r2 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "gcc main.c" } }, h.ctx);
	assert.strictEqual(r2, undefined);
	assert.strictEqual(h.calls.classify, 2);
	assert.strictEqual(h.calls.complete, 1, "Stage 1 标记拦截后必须流转 Stage 2");

	// 3. upstream_error → Stage 2 接管 + 首次降级通知 + 状态栏 S1 徽标
	h.setClassify(async () => ({ stopReason: "error", errorMessage: "HTTP 502" }));
	const r3 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "awk x" } }, h.ctx);
	assert.strictEqual(r3, undefined, "Stage 1 失败必须由 Stage 2 接管，绝不阻塞 Agent");
	assert.strictEqual(h.calls.complete, 2);
	let degraded = h.notices.filter((n) => n.msg.includes("Stage 1 快速快筛响应异常"));
	assert.strictEqual(degraded.length, 1);
	assert.match(degraded[0].msg, /upstream_error/);
	assert.ok(h.statuses[h.statuses.length - 1].includes("S1⚠️"), "状态栏必须联动 S1⚠️ 徽标");

	// 4. 连续第 2 次失败：通知去重不刷屏
	await h.handlers["tool_call"]({ toolName: "bash", input: { command: "awk y" } }, h.ctx);
	degraded = h.notices.filter((n) => n.msg.includes("Stage 1 快速快筛响应异常"));
	assert.strictEqual(degraded.length, 1, "降级通知必须去重");

	// 5. classify 意外抛错 → exception 归因，Stage 2 接管
	h.setClassify(async () => {
		throw new Error("boom");
	});
	const r5 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "awk z" } }, h.ctx);
	assert.strictEqual(r5, undefined);
	assert.strictEqual(h.calls.complete, 4);

	// 6. 非法响应（answers 缺失）→ invalid_response 归因，Stage 2 接管
	h.setClassify(async () => ({ stopReason: "stop", answers: {} }));
	const r6 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "awk w" } }, h.ctx);
	assert.strictEqual(r6, undefined);
	assert.strictEqual(h.calls.complete, 5);

	// 7. 累计 4 次失败 < 5，不得触发阶梯升级通知
	const escalated = h.notices.filter((n) => n.msg.includes("已连续失败 5 次"));
	assert.strictEqual(escalated.length, 0);

	// 8. 恢复正常 → 成功复位健康度，状态栏回退无 S1⚠️
	h.setClassify(async () => stopResult(0.02));
	await h.handlers["tool_call"]({ toolName: "bash", input: { command: "pwd" } }, h.ctx);
	assert.ok(!h.statuses[h.statuses.length - 1].includes("S1⚠️"), "成功后状态栏必须复位");
});

test("e2e: 手工配置 classifier 为 Stage 2 时回退通用 LLM，绝不对 classifier 调 complete()", async () => {
	writeAgentConfig({
		classifierStage1Model: "openrouter/typesafe/jev-1.13",
		classifierStage2Model: "openrouter/typesafe/jev-1.13",
	});
	const h = await setupHarness({ registry: makeCatalogRegistry() });

	// Stage 1 标记拦截 → Stage 2 解析跳过 classifier，回退到主模型走 complete()
	h.setClassify(async () => stopResult(0.99));
	const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, h.ctx);
	assert.strictEqual(r, undefined);
	assert.strictEqual(h.calls.classify, 1, "Stage 1 只派发一次 classify");
	assert.strictEqual(h.calls.complete, 1, "Stage 2 必须走 complete()");
	assert.strictEqual(h.lastCompleteModel().id, "main-model", "Stage 2 应回退到主模型（通用 LLM）");
	// 回退原因必须通知（配置无效提示）
	const fallbackNotices = h.notices.filter((n) => n.msg.includes("无效，已降级"));
	assert.ok(fallbackNotices.length >= 1, "Stage 2 的 classifier 配置回退必须有降级通知");
});

// =========================================================================
// 测试脚手架
// =========================================================================

async function setupHarness(opts: { registry: any }): Promise<{
	handlers: Record<string, Function>;
	commands: Record<string, any>;
	notices: { msg: string; level?: string }[];
	statuses: string[];
	ctx: any;
	calls: { classify: number; complete: number };
	setClassify: (fn: (model: any, context: any, options: any) => Promise<any>) => void;
	lastClassifyArgs: () => { model: any; context: any; options: any };
	lastCompleteModel: () => any;
}> {
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};
	const notices: { msg: string; level?: string }[] = [];
	const statuses: string[] = [];
	const calls = { classify: 0, complete: 0 };

	let classifyImpl: (model: any, context: any, options: any) => Promise<any> = async () => stopResult(0.01);
	let seenClassify: any = null;
	let seenCompleteModel: any = null;

	const registry = opts.registry;
	registry.classify = async (model: any, context: any, options: any) => {
		calls.classify++;
		seenClassify = { model, context, options };
		return await classifyImpl(model, context, options);
	};
	registry.complete = async (model: any) => {
		calls.complete++;
		seenCompleteModel = model;
		return {
			content: [{ type: "text", text: JSON.stringify({ shouldBlock: false, reason: "stage2 pass" }) }],
		};
	};

	const pi: any = {
		registerFlag: () => {},
		registerCommand: (name: string, def: any) => {
			commands[name] = def;
		},
		registerShortcut: () => {},
		getActiveTools: () => ["bash", "edit", "write", "read"],
		setActiveTools: () => {},
		on: (event: string, handler: Function) => {
			handlers[event] = handler;
		},
		appendEntry: () => {},
		getFlag: (name: string) => (name === "approval-mode" ? "auto" : undefined),
	};
	approvalModeExtension(pi);

	const mainModel = { provider: "test", id: "main-model" };
	const ctx: any = {
		cwd: tempBase,
		hasUI: true,
		model: mainModel,
		modelRegistry: registry,
		ui: {
			notify: (msg: string, level?: string) => notices.push({ msg, level }),
			select: async () => null,
			theme: { fg: (_c: string, t?: string) => t },
			setStatus: (_k: string, s: string) => statuses.push(s),
		},
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	await handlers["session_start"]({ reason: "start" }, ctx);

	return {
		handlers,
		commands,
		notices,
		statuses,
		ctx,
		calls,
		setClassify: (fn) => {
			classifyImpl = fn;
		},
		lastClassifyArgs: () => seenClassify,
		lastCompleteModel: () => seenCompleteModel,
	};
}
