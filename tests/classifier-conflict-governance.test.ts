import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试环境隔离
const tempBase = mkdtempSync(join(tmpdir(), "pi-issue-0047-"));
const agentDir = join(tempBase, "agent");
process.env.HOME = tempBase;
process.env.USERPROFILE = tempBase;
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });

import approvalModeExtension, {
	resolveClassifierModel,
	detectClassifierConflict,
	buildClassifierConflictWarning,
	buildBaseClassifierWarning,
	buildStage2ClassifierWarning,
	isClassifierTypeModel,
} from "../extensions/approval-mode.ts";

test.after(() => {
	rmSync(tempBase, { recursive: true, force: true });
});

const classifierModel = {
	type: "classifier",
	id: "typesafe/jev-1.13",
	name: "TypeSafe: Jev 1.13",
	api: "typesafe_system_one",
	provider: "openrouter",
	cost: { input: 0.042, output: 0 },
	contextWindow: 32000,
};

const chatModels = [
	{ provider: "test", id: "base-model", name: "Base Model" },
	{ provider: "test", id: "stage1-model", name: "Stage 1 Model" },
	{ provider: "test", id: "stage2-model", name: "Stage 2 Model" },
	{ provider: "ctx", id: "main", name: "Main Context Model" },
	{ provider: "llm-proxy-openai-chat", id: "gemini-3.8-flash-high-lp", name: "Default Gemini" },
];

function createHarness(opts?: { authFilter?: (m: any) => boolean }) {
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};
	const notifySpy: { message: string; type?: string }[] = [];

	const auth = opts?.authFilter ?? (() => true);

	const registry: any = {
		find: (p: string, id: string) => chatModels.find((m) => m.provider === p && m.id === id) ?? null,
		getAll: () => chatModels,
		hasConfiguredAuth: auth,
		findOfType: (type: string, provider: string, id: string) =>
			type === "classifier" && provider === "openrouter" && id === "typesafe/jev-1.13"
				? classifierModel
				: undefined,
		getModelsOfType: (type: string) => (type === "classifier" ? [classifierModel] : chatModels),
	};

	const pi: any = {
		registerFlag: () => {},
		registerCommand: (name: string, def: any) => { commands[name] = def; },
		registerShortcut: () => {},
		getActiveTools: () => ["bash", "edit"],
		setActiveTools: () => {},
		on: (event: string, handler: Function) => { handlers[event] = handler; },
		appendEntry: () => {},
		getFlag: (name: string) => (name === "approval-mode" ? "auto" : undefined),
	};

	approvalModeExtension(pi);

	const ctx: any = {
		modelRegistry: registry,
		model: chatModels.find((m) => m.id === "main"),
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => {
				notifySpy.push({ message, type });
			},
			setStatus: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
		cwd: tempBase,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	return { handlers, commands, notifySpy, ctx };
}

function writeConfigFile(cfg: Record<string, any>): string {
	const p = join(agentDir, "approval-config.json");
	const content = JSON.stringify(cfg, null, 2);
	writeFileSync(p, content, "utf-8");
	return content;
}

function readConfigRaw(): string {
	return readFileSync(join(agentDir, "approval-config.json"), "utf-8");
}

// ==========================================
// 1. 纯逻辑函数测试
// ==========================================
test("detectClassifierConflict 纯逻辑判定准确性", () => {
	assert.strictEqual(
		detectClassifierConflict({
			classifierModel: "test/base",
			classifierStage1Model: "test/s1",
			classifierStage2Model: "test/s2",
		}),
		true,
	);
	assert.strictEqual(
		detectClassifierConflict({
			classifierModel: "test/base",
			classifierStage1Model: "test/s1",
		}),
		false,
	);
	assert.strictEqual(
		detectClassifierConflict({
			classifierStage1Model: "test/s1",
			classifierStage2Model: "test/s2",
		}),
		false,
	);
	assert.strictEqual(
		detectClassifierConflict({}),
		false,
	);
	assert.strictEqual(
		detectClassifierConflict({
			classifierModel: "test/base",
		}),
		false,
	);
});

test("isClassifierTypeModel 识别原生专职分类器与普通模型", () => {
	const harness = createHarness();
	assert.strictEqual(isClassifierTypeModel(harness.ctx.modelRegistry, "openrouter/typesafe/jev-1.13"), true);
	assert.strictEqual(isClassifierTypeModel(harness.ctx.modelRegistry, "typesafe/jev-1.13"), true);
	assert.strictEqual(isClassifierTypeModel(harness.ctx.modelRegistry, "test/base-model"), false);
	assert.strictEqual(isClassifierTypeModel(harness.ctx.modelRegistry, undefined), false);
	assert.strictEqual(isClassifierTypeModel(null, "test/base-model"), false);
});

test("告警文案构建函数输出正确", () => {
	assert.ok(buildClassifierConflictWarning("test/base").includes("test/base"));
	assert.ok(buildClassifierConflictWarning("test/base").includes("就地忽略"));
	assert.ok(buildBaseClassifierWarning("openrouter/typesafe/jev-1.13").includes("专职分类器"));
	assert.ok(buildBaseClassifierWarning("openrouter/typesafe/jev-1.13").includes("通用 LLM"));
	assert.ok(buildStage2ClassifierWarning("openrouter/typesafe/jev-1.13").includes("Stage 2"));
	assert.ok(buildStage2ClassifierWarning("openrouter/typesafe/jev-1.13").includes("人类可读理由"));
});

// ==========================================
// 2. 三方共存告警、Zero Disk Mutation 与旁路生效
// ==========================================
test("三方共存触发 Loud Ignore 告警、磁盘零修改、专属生效且底座忽略", async () => {
	const harness = createHarness();
	const initialRaw = writeConfigFile({
		classifierModel: "test/base-model",
		classifierStage1Model: "test/stage1-model",
		classifierStage2Model: "test/stage2-model",
		comment: "preserve user comments and format",
	});

	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);

	// 1. 验证告警文案完全命中
	const expectedWarning = buildClassifierConflictWarning("test/base-model");
	const conflictWarn = harness.notifySpy.find((n) => n.message.includes("检测到分类器模型配置冲突"));
	assert.ok(conflictWarn, "必须触发三方共存告警");
	assert.strictEqual(conflictWarn.type, "warning");
	assert.strictEqual(conflictWarn.message, expectedWarning);

	// 2. 验证磁盘纯洁性（Zero Disk Mutation）
	const currentRaw = readConfigRaw();
	assert.strictEqual(currentRaw, initialRaw, "磁盘配置文件必须保持字节级一致，绝不篡改");

	// 3. 验证 /classifier-model 状态命令输出包含冲突忽略标注
	harness.notifySpy.length = 0;
	await harness.commands["classifier-model"].handler("", harness.ctx);
	const statusMsg = harness.notifySpy[harness.notifySpy.length - 1]?.message ?? "";
	assert.ok(
		statusMsg.includes("公共底座: 配置值 test/base-model [⚠️ 冲突已忽略：两阶段均已单独指定，此项未启用]"),
		"状态报告必须透明标明底座已被冲突忽略",
	);
	assert.ok(statusMsg.includes("Stage 1: 配置值 test/stage1-model → 生效值 test/stage1-model"));
	assert.ok(statusMsg.includes("Stage 2: 配置值 test/stage2-model → 生效值 test/stage2-model"));
});

// ==========================================
// 3. 专属模型失效绝不穿透回退到底座（切断穿透备胎）
// ==========================================
test("三方共存时专属模型失效绝不穿透回退到底座", async () => {
	// mock: base-model 鉴权通过，invalid-s1 与 invalid-s2 鉴权失败/不存在
	const harness = createHarness({
		authFilter: (m: any) => m.id === "base-model" || m.id === "gemini-3.8-flash-high-lp",
	});

	writeConfigFile({
		classifierModel: "test/base-model",
		classifierStage1Model: "test/invalid-s1",
		classifierStage2Model: "test/invalid-s2",
	});

	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);

	harness.notifySpy.length = 0;
	await harness.commands["classifier-model"].handler("", harness.ctx);
	const statusMsg = harness.notifySpy[harness.notifySpy.length - 1]?.message ?? "";

	// Stage 1 和 Stage 2 均失效时，必须直接回退到内置默认 gemini-3.8-flash-high-lp，绝不能回退到 test/base-model
	assert.ok(
		statusMsg.includes("Stage 1: 配置值 test/invalid-s1 → 生效值 llm-proxy-openai-chat/gemini-3.8-flash-high-lp"),
		"Stage 1 失效后绝不可穿透回退到底座 base-model",
	);
	assert.ok(
		statusMsg.includes("Stage 2: 配置值 test/invalid-s2 → 生效值 llm-proxy-openai-chat/gemini-3.8-flash-high-lp"),
		"Stage 2 失效后绝不可穿透回退到底座 base-model",
	);
	assert.ok(!statusMsg.includes("生效值 test/base-model"), "无论如何生效值中不得出现被忽略的 base-model");
});

// ==========================================
// 4. 底座角色契约校验与 Stage 2 继承阻断
// ==========================================
test("classifierModel 配置为专职分类器时发出告警并阻断 Stage 2 继承", async () => {
	const harness = createHarness();
	writeConfigFile({
		classifierModel: "openrouter/typesafe/jev-1.13",
	});

	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);

	// 1. 验证底座专职分类器告警
	const expectedWarning = buildBaseClassifierWarning("openrouter/typesafe/jev-1.13");
	const baseWarn = harness.notifySpy.find((n) => n.message.includes("公共底座") && n.message.includes("专职分类器"));
	assert.ok(baseWarn, "底座配置专职分类器时必须告警");
	assert.strictEqual(baseWarn.type, "warning");
	assert.strictEqual(baseWarn.message, expectedWarning);

	// 2. 验证 Stage 2 解析绝不继承专职分类器
	harness.notifySpy.length = 0;
	await harness.commands["classifier-model"].handler("", harness.ctx);
	const statusMsg = harness.notifySpy[harness.notifySpy.length - 1]?.message ?? "";

	// Stage 2 必须被拦截阻断，回退到内置默认
	assert.ok(
		statusMsg.includes("Stage 2: 配置值 未配置 → 生效值 llm-proxy-openai-chat/gemini-3.8-flash-high-lp"),
		"Stage 2 必须阻断继承专职分类器底座并回退内置默认",
	);

	// 3. 验证 resolveClassifierModel 直接解析 Stage 2 同样无法获取专职分类器
	const directS2 = resolveClassifierModel(
		harness.ctx,
		undefined,
		"openrouter/typesafe/jev-1.13",
		false,
		"Stage 2",
		false,
	);
	assert.notStrictEqual(directS2.label, "openrouter/typesafe/jev-1.13");
	assert.strictEqual(directS2.label, "llm-proxy-openai-chat/gemini-3.8-flash-high-lp");
});

// ==========================================
// 5. Stage 2 配置为专职分类器时告警
// ==========================================
test("classifierStage2Model 配置为专职分类器时发出告警", async () => {
	const harness = createHarness();
	writeConfigFile({
		classifierStage2Model: "openrouter/typesafe/jev-1.13",
	});

	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);

	const s2Warn = harness.notifySpy.find((n) => n.message.includes("Stage 2 专属模型") && n.message.includes("专职分类器"));
	assert.ok(s2Warn, "Stage 2 配置专职分类器时必须告警");
	assert.strictEqual(s2Warn.type, "warning");
	assert.strictEqual(s2Warn.message, buildStage2ClassifierWarning("openrouter/typesafe/jev-1.13"));
});

// ==========================================
// 6. 非冲突拓扑不触发告警
// ==========================================
test("合法拓扑（仅底座 / 底座+Stage1 / Stage1+Stage2）不触发冲突告警", async () => {
	// 形态一：仅底座
	const h1 = createHarness();
	writeConfigFile({ classifierModel: "test/base-model" });
	await h1.handlers["session_start"]({ reason: "start" }, h1.ctx);
	assert.ok(!h1.notifySpy.some((n) => n.message.includes("检测到分类器模型配置冲突")), "仅底座不应触发冲突告警");

	// 形态二：底座 + Stage1
	const h2 = createHarness();
	writeConfigFile({ classifierModel: "test/base-model", classifierStage1Model: "test/stage1-model" });
	await h2.handlers["session_start"]({ reason: "start" }, h2.ctx);
	assert.ok(!h2.notifySpy.some((n) => n.message.includes("检测到分类器模型配置冲突")), "底座+Stage1 不应触发冲突告警");

	// 形态三：Stage1 + Stage2（无底座）
	const h3 = createHarness();
	writeConfigFile({ classifierStage1Model: "test/stage1-model", classifierStage2Model: "test/stage2-model" });
	await h3.handlers["session_start"]({ reason: "start" }, h3.ctx);
	assert.ok(!h3.notifySpy.some((n) => n.message.includes("检测到分类器模型配置冲突")), "Stage1+Stage2 不应触发冲突告警");
});

// ==========================================
// 7. 状态报告非冲突时不显示忽略标记
// ==========================================
test("合法拓扑下状态报告不包含冲突忽略标记", async () => {
	const harness = createHarness();
	writeConfigFile({ classifierModel: "test/base-model" });
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);

	harness.notifySpy.length = 0;
	await harness.commands["classifier-model"].handler("", harness.ctx);
	const statusMsg = harness.notifySpy[harness.notifySpy.length - 1]?.message ?? "";
	assert.ok(!statusMsg.includes("冲突已忽略"), "合法拓扑下状态报告不应包含冲突忽略标记");
});
