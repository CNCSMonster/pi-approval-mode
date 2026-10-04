import assert from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 测试环境隔离：在模块顶层重定向 HOME 与 PI_CODING_AGENT_DIR 到独立临时目录
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-issue-0036-"));
process.env.HOME = path.join(tempBase, "home");
process.env.PI_CODING_AGENT_DIR = path.join(tempBase, "agent");
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

import approvalModeExtension, {
	parseClassifierModelArgs,
	formatModelCost,
	formatModelCtx,
	buildModelDescription,
	CLASSIFIER_USAGE,
	CLASSIFIER_HELP_TEXT,
} from "../extensions/approval-mode.ts";

function readGlobalConfigFile(): any {
	const p = path.join(process.env.PI_CODING_AGENT_DIR!, "approval-config.json");
	if (!fs.existsSync(p)) return {};
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch {
		return {};
	}
}

// 模拟模型与模型注册表
const modelStage1 = {
	provider: "test",
	id: "stage1",
	cost: { input: 0.3, output: 1.2 },
	reasoning: true,
	contextWindow: 1_000_000,
};
const modelStage2 = {
	provider: "test",
	id: "stage2",
	cost: { input: 2, output: 10 },
	reasoning: false,
	contextWindow: 128_000,
};
const modelMain = {
	provider: "ctx",
	id: "main",
	cost: { input: 0, output: 0 },
	reasoning: false,
	contextWindow: 0,
};
const modelNoAuth = {
	provider: "test",
	id: "noauth",
	cost: { input: 1, output: 1 },
	reasoning: false,
	contextWindow: 32_000,
};

function createMockHarness() {
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};
	const notifySpy: { message: string; type?: string }[] = [];

	const allModels = [modelStage1, modelStage2, modelMain, modelNoAuth];

	const registry = {
		find(provider: string, id: string) {
			return allModels.find((m) => m.provider === provider && m.id === id) ?? null;
		},
		getAll() {
			return allModels;
		},
		hasConfiguredAuth(m: any) {
			return m.id !== "noauth";
		},
	};

	const pi: any = {
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
		getFlag: (name: string) => (name === "approval-mode" ? "auto" : undefined),
	};

	approvalModeExtension(pi);

	const ctx: any = {
		modelRegistry: registry,
		model: modelMain,
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => {
				notifySpy.push({ message, type });
			},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t },
		},
		cwd: "/test",
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	return { handlers, commands, notifySpy, ctx };
}

// ==========================================
// 1. 纯解析器（parseClassifierModelArgs）断言
// ==========================================

test("Parser: 空入参 -> status", () => {
	assert.deepStrictEqual(parseClassifierModelArgs(""), { kind: "status" });
	assert.deepStrictEqual(parseClassifierModelArgs("   \t  \n "), { kind: "status" });
});

test("Parser: help 子命令与其约束（C8）", () => {
	assert.deepStrictEqual(parseClassifierModelArgs("help"), { kind: "help" });
	assert.deepStrictEqual(parseClassifierModelArgs("  help  "), { kind: "help" });

	const errC8 = parseClassifierModelArgs("help extra");
	assert.strictEqual(errC8.kind, "error");
	assert.match((errC8 as any).message, /必须单独使用/);
});

test("Parser: clear 子命令合法与互斥（C1, C2, C3, C6）", () => {
	assert.deepStrictEqual(parseClassifierModelArgs("clear"), { kind: "clear", targets: [] });
	assert.deepStrictEqual(parseClassifierModelArgs("clear --stage1"), { kind: "clear", targets: ["--stage1"] });
	assert.deepStrictEqual(parseClassifierModelArgs("clear --stage2"), { kind: "clear", targets: ["--stage2"] });
	assert.deepStrictEqual(parseClassifierModelArgs("clear --stage1 --stage2"), { kind: "clear", targets: ["--stage1", "--stage2"] });
	assert.deepStrictEqual(parseClassifierModelArgs("clear --both"), { kind: "clear", targets: ["--both"] });

	// 重复 flag C1
	const dup = parseClassifierModelArgs("clear --stage1 --stage1");
	assert.strictEqual(dup.kind, "error");
	assert.match((dup as any).message, /重复 flag/);

	// both 与 stage 互斥 C2
	const bothMix1 = parseClassifierModelArgs("clear --both --stage1");
	assert.strictEqual(bothMix1.kind, "error");
	assert.match((bothMix1 as any).message, /互斥/);

	const bothMix2 = parseClassifierModelArgs("clear --stage1 --both");
	assert.strictEqual(bothMix2.kind, "error");
	assert.match((bothMix2 as any).message, /互斥/);

	// clear 后跟随位置入参/模型值 C3/C5
	const pos = parseClassifierModelArgs("clear test/stage1");
	assert.strictEqual(pos.kind, "error");
	assert.match((pos as any).message, /仅接受目标 flag/);

	// 未知 flag C6
	const unknown = parseClassifierModelArgs("clear --unknown");
	assert.strictEqual(unknown.kind, "error");
	assert.match((unknown as any).message, /未知 flag/);
});

test("Parser: 设置 flags 正常与冲突规则（C1~C8）", () => {
	// 正常
	assert.deepStrictEqual(parseClassifierModelArgs("--stage1 test/stage1"), {
		kind: "set",
		pairs: [{ flag: "--stage1", model: "test/stage1" }],
	});
	assert.deepStrictEqual(parseClassifierModelArgs("--stage1 test/a --stage2 test/b"), {
		kind: "set",
		pairs: [
			{ flag: "--stage1", model: "test/a" },
			{ flag: "--stage2", model: "test/b" },
		],
	});
	assert.deepStrictEqual(parseClassifierModelArgs("--stage2 test/b --stage1 test/a"), {
		kind: "set",
		pairs: [
			{ flag: "--stage2", model: "test/b" },
			{ flag: "--stage1", model: "test/a" },
		],
	});
	assert.deepStrictEqual(parseClassifierModelArgs("--both test/stage1"), {
		kind: "set",
		pairs: [{ flag: "--both", model: "test/stage1" }],
	});

	// C1: 重复 flag
	const dup = parseClassifierModelArgs("--stage1 test/a --stage1 test/b");
	assert.strictEqual(dup.kind, "error");
	assert.match((dup as any).message, /重复 flag/);

	const dupBoth = parseClassifierModelArgs("--both test/a --both test/b");
	assert.strictEqual(dupBoth.kind, "error");
	assert.match((dupBoth as any).message, /重复 flag/);

	// C2: both 与 stage 互斥
	const bothStage = parseClassifierModelArgs("--both test/a --stage1 test/b");
	assert.strictEqual(bothStage.kind, "error");
	assert.match((bothStage as any).message, /互斥/);

	const bothStage2 = parseClassifierModelArgs("--both test/a --stage2 test/b");
	assert.strictEqual(bothStage2.kind, "error");
	assert.match((bothStage2 as any).message, /互斥/);

	const stageBoth = parseClassifierModelArgs("--stage1 test/b --both test/a");
	assert.strictEqual(stageBoth.kind, "error");
	assert.match((stageBoth as any).message, /互斥/);

	const stage2Both = parseClassifierModelArgs("--stage2 test/b --both test/a");
	assert.strictEqual(stage2Both.kind, "error");
	assert.match((stage2Both as any).message, /互斥/);

	// C3: clear 出现在非首位
	const clearMix = parseClassifierModelArgs("--stage1 test/a clear");
	assert.strictEqual(clearMix.kind, "error");
	assert.match((clearMix as any).message, /"clear" 只能作为首 token/);

	// C4: clear 作值
	const clearVal = parseClassifierModelArgs("--stage1 clear");
	assert.strictEqual(clearVal.kind, "error");
	assert.match((clearVal as any).message, /"clear" 不能作为 flag 的值/);

	// C5: 位置入参（旧语法或孤立参数）
	const posOld = parseClassifierModelArgs("test/stage1");
	assert.strictEqual(posOld.kind, "error");
	assert.match((posOld as any).message, /不支持位置入参/);

	const posDefault = parseClassifierModelArgs("default");
	assert.strictEqual(posDefault.kind, "error");
	assert.match((posDefault as any).message, /不支持位置入参/);

	const posTail = parseClassifierModelArgs("--stage1 test/a extra");
	assert.strictEqual(posTail.kind, "error");
	assert.match((posTail as any).message, /不支持位置入参/);

	// C6: 未知 flag、缺值、值以 -- 开头
	const unknownFlag = parseClassifierModelArgs("--unknown test/a");
	assert.strictEqual(unknownFlag.kind, "error");
	assert.match((unknownFlag as any).message, /未知 flag/);

	const missingVal = parseClassifierModelArgs("--stage1");
	assert.strictEqual(missingVal.kind, "error");
	assert.match((missingVal as any).message, /缺少模型值/);

	const valStartsHyphen = parseClassifierModelArgs("--stage1 --stage2 test/a");
	assert.strictEqual(valStartsHyphen.kind, "error");
	assert.match((valStartsHyphen as any).message, /不能以 "--" 开头/);

	// C7: flag 严格小写
	const upper = parseClassifierModelArgs("--Stage1 test/a");
	assert.strictEqual(upper.kind, "error");
	assert.match((upper as any).message, /严格小写/);

	const upperStage2 = parseClassifierModelArgs("--STAGE2 test/a");
	assert.strictEqual(upperStage2.kind, "error");
	assert.match((upperStage2 as any).message, /严格小写/);

	const upperBoth = parseClassifierModelArgs("--Both test/a");
	assert.strictEqual(upperBoth.kind, "error");
	assert.match((upperBoth as any).message, /严格小写/);

	const upperClear = parseClassifierModelArgs("clear --STAGE1");
	assert.strictEqual(upperClear.kind, "error");
	assert.match((upperClear as any).message, /严格小写/);

	// 多空格与制表符鲁棒性
	const multiSpace = parseClassifierModelArgs(" \t --stage1  \t test/a  \n  --stage2 \t  test/b  ");
	assert.deepStrictEqual(multiSpace, {
		kind: "set",
		pairs: [
			{ flag: "--stage1", model: "test/a" },
			{ flag: "--stage2", model: "test/b" },
		],
	});

	// C8: help 混用或作值
	const helpMix = parseClassifierModelArgs("--stage1 test/a help");
	assert.strictEqual(helpMix.kind, "error");
	assert.match((helpMix as any).message, /"help" 必须单独使用/);

	const helpVal = parseClassifierModelArgs("--stage1 help");
	assert.strictEqual(helpVal.kind, "error");
	assert.match((helpVal as any).message, /"help" 不能作为 flag 的值/);
});

// ==========================================
// 2. 格式化工具纯函数（D3）断言
// ==========================================

test("D3: formatModelCost 与 formatModelCtx 格式化", () => {
	assert.strictEqual(formatModelCost(0.3, 1.2), "$0.3/$1.2 per M");
	assert.strictEqual(formatModelCost(2, 10), "$2/$10 per M");
	assert.strictEqual(formatModelCost(0, 0), "$0/$0 per M");

	assert.strictEqual(formatModelCtx(1_000_000), "1M ctx");
	assert.strictEqual(formatModelCtx(1_500_000), "1.5M ctx");
	assert.strictEqual(formatModelCtx(128_000), "128K ctx");
	assert.strictEqual(formatModelCtx(0), "");
});

test("D3: buildModelDescription 优先级与省略段", () => {
	// 全部齐全且当前生效
	const descFull = buildModelDescription(
		{ cost: { input: 0.3, output: 1.2 }, reasoning: true, contextWindow: 1_000_000 },
		true,
	);
	assert.strictEqual(descFull, "✓ $0.3/$1.2 per M · reasoning · 1M ctx");

	// 缺失 reasoning 与 cost 为 0
	const descSparse = buildModelDescription(
		{ cost: { input: 0, output: 0 }, reasoning: false, contextWindow: 128_000 },
		false,
	);
	assert.strictEqual(descSparse, "128K ctx");

	// 全无且非当前生效 -> undefined
	assert.strictEqual(buildModelDescription({ reasoning: false, contextWindow: 0 }, false), undefined);

	// 全无但当前生效 -> ✓ 当前生效
	assert.strictEqual(buildModelDescription({ reasoning: false, contextWindow: 0 }, true), "✓ 当前生效");
});

// ==========================================
// 3. 端到端命令执行（handler）与文件落盘断言
// ==========================================

test("E2E: status 与 help 输出规范", async () => {
	const harness = createMockHarness();
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);

	// status: 附带用法行 D4
	await harness.commands["classifier-model"].handler("", harness.ctx);
	const lastStatus = harness.notifySpy[harness.notifySpy.length - 1];
	assert.strictEqual(lastStatus.type, "info");
	assert.match(lastStatus.message, /当前审批分类器模型状态/);
	assert.match(lastStatus.message, new RegExp(CLASSIFIER_USAGE.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")));

	// help: 输出 CLASSIFIER_HELP_TEXT
	await harness.commands["classifier-model"].handler("help", harness.ctx);
	const lastHelp = harness.notifySpy[harness.notifySpy.length - 1];
	assert.strictEqual(lastHelp.type, "info");
	assert.strictEqual(lastHelp.message, CLASSIFIER_HELP_TEXT);
});

test("E2E: 单 flag、组合 flag 与 --both 落盘语义", async () => {
	const harness = createMockHarness();
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
	await harness.commands["classifier-model"].handler("clear", harness.ctx);

	// 1. 设置 --stage1
	await harness.commands["classifier-model"].handler("--stage1 test/stage1", harness.ctx);
	let cfg = readGlobalConfigFile();
	assert.strictEqual(cfg.classifierStage1Model, "test/stage1");
	assert.strictEqual(cfg.classifierStage2Model, undefined);
	assert.strictEqual(cfg.classifierModel, undefined);

	// 2. 追加 --stage2（仅给子集时未提及键不变）
	await harness.commands["classifier-model"].handler("--stage2 test/stage2", harness.ctx);
	cfg = readGlobalConfigFile();
	assert.strictEqual(cfg.classifierStage1Model, "test/stage1");
	assert.strictEqual(cfg.classifierStage2Model, "test/stage2");
	assert.strictEqual(cfg.classifierModel, undefined);

	// 3. --both 设置：清空 stage1/stage2，写入 shared
	await harness.commands["classifier-model"].handler("--both test/stage1", harness.ctx);
	cfg = readGlobalConfigFile();
	assert.strictEqual(cfg.classifierModel, "test/stage1");
	assert.strictEqual(cfg.classifierStage1Model, undefined);
	assert.strictEqual(cfg.classifierStage2Model, undefined);

	// 4. 两阶段一次性设置（顺序无关）
	await harness.commands["classifier-model"].handler("--stage2 test/stage2 --stage1 test/stage1", harness.ctx);
	cfg = readGlobalConfigFile();
	assert.strictEqual(cfg.classifierStage1Model, "test/stage1");
	assert.strictEqual(cfg.classifierStage2Model, "test/stage2");
	assert.strictEqual(cfg.classifierModel, "test/stage1"); // 未提及的 shared 键保留
});

test("E2E: clear 目标清除与全局重置", async () => {
	const harness = createMockHarness();
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);

	// 预设三键俱全
	await harness.commands["classifier-model"].handler("--both test/stage1", harness.ctx);
	await harness.commands["classifier-model"].handler("--stage1 test/stage1 --stage2 test/stage2", harness.ctx);
	let cfg = readGlobalConfigFile();
	assert.strictEqual(cfg.classifierStage1Model, "test/stage1");
	assert.strictEqual(cfg.classifierStage2Model, "test/stage2");
	assert.strictEqual(cfg.classifierModel, "test/stage1");

	// 1. clear --stage1: 仅清除 stage1 键
	await harness.commands["classifier-model"].handler("clear --stage1", harness.ctx);
	cfg = readGlobalConfigFile();
	assert.strictEqual(cfg.classifierStage1Model, undefined);
	assert.strictEqual(cfg.classifierStage2Model, "test/stage2");
	assert.strictEqual(cfg.classifierModel, "test/stage1");

	// 2. clear --stage2: 清除 stage2 键，共享键保留
	await harness.commands["classifier-model"].handler("clear --stage2", harness.ctx);
	cfg = readGlobalConfigFile();
	assert.strictEqual(cfg.classifierStage1Model, undefined);
	assert.strictEqual(cfg.classifierStage2Model, undefined);
	assert.strictEqual(cfg.classifierModel, "test/stage1");

	// 3. 重新设置 stage1/stage2，测试 clear --stage1 --stage2
	await harness.commands["classifier-model"].handler("--stage1 test/stage1 --stage2 test/stage2", harness.ctx);
	await harness.commands["classifier-model"].handler("clear --stage1 --stage2", harness.ctx);
	cfg = readGlobalConfigFile();
	assert.strictEqual(cfg.classifierStage1Model, undefined);
	assert.strictEqual(cfg.classifierStage2Model, undefined);
	assert.strictEqual(cfg.classifierModel, "test/stage1");

	// 4. clear（裸命令）或 clear --both: 三键全清
	await harness.commands["classifier-model"].handler("clear", harness.ctx);
	cfg = readGlobalConfigFile();
	assert.strictEqual(cfg.classifierStage1Model, undefined);
	assert.strictEqual(cfg.classifierStage2Model, undefined);
	assert.strictEqual(cfg.classifierModel, undefined);
});

test("E2E: D1 全有或全无校验与错误整条不落盘", async () => {
	const harness = createMockHarness();
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
	await harness.commands["classifier-model"].handler("clear", harness.ctx);

	// 1. 单个未找到模型报错
	await harness.commands["classifier-model"].handler("--stage1 test/not-exist", harness.ctx);
	let last = harness.notifySpy[harness.notifySpy.length - 1];
	assert.strictEqual(last.type, "error");
	assert.match(last.message, /未找到该模型/);
	assert.deepStrictEqual(readGlobalConfigFile(), {});

	// 2. 无认证模型报错
	await harness.commands["classifier-model"].handler("--stage1 test/noauth", harness.ctx);
	last = harness.notifySpy[harness.notifySpy.length - 1];
	assert.strictEqual(last.type, "error");
	assert.match(last.message, /未配置有效认证/);
	assert.deepStrictEqual(readGlobalConfigFile(), {});

	// 3. 部分有效部分无效：整条命令全有或全无，有效部分也不得保存
	await harness.commands["classifier-model"].handler("--stage1 test/stage1 --stage2 test/noauth", harness.ctx);
	last = harness.notifySpy[harness.notifySpy.length - 1];
	assert.strictEqual(last.type, "error");
	assert.match(last.message, /整条命令未保存（全有或全无）/);
	assert.deepStrictEqual(readGlobalConfigFile(), {});

	// 4. 解析错误同样整条不落盘
	await harness.commands["classifier-model"].handler("--stage1 clear", harness.ctx);
	last = harness.notifySpy[harness.notifySpy.length - 1];
	assert.strictEqual(last.type, "error");
	assert.match(last.message, /"clear" 不能作为 flag 的值/);
	assert.deepStrictEqual(readGlobalConfigFile(), {});
});

// ==========================================
// 4. 自动补全状态机（getArgumentCompletions）断言
// ==========================================

test("Completion: START 与子命令/前缀过滤", async () => {
	const harness = createMockHarness();
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
	const getCompletions = harness.commands["classifier-model"].getArgumentCompletions;

	// 空前缀：5 项候选
	const startAll = getCompletions("");
	assert.ok(Array.isArray(startAll));
	assert.strictEqual(startAll.length, 5);
	assert.deepStrictEqual(
		startAll.map((i: any) => i.value),
		["--stage1", "--stage2", "--both", "clear", "help"],
	);

	// 前缀 --：按前缀过滤出 3 个 flags
	const startHyphen = getCompletions("--");
	assert.ok(Array.isArray(startHyphen));
	assert.strictEqual(startHyphen.length, 3);
	assert.deepStrictEqual(
		startHyphen.map((i: any) => i.value),
		["--stage1", "--stage2", "--both"],
	);

	// 前缀 cl -> clear
	const cl = getCompletions("cl");
	assert.strictEqual(cl?.length, 1);
	assert.strictEqual(cl[0].value, "clear");

	// 前缀 h -> help
	const h = getCompletions("h");
	assert.strictEqual(h?.length, 1);
	assert.strictEqual(h[0].value, "help");

	// help 单独使用后补全无候选（HELP_DONE）
	assert.strictEqual(getCompletions("help "), null);
	assert.strictEqual(getCompletions("help extra"), null);
});

test("Completion: clear 目标补全与互斥过滤", async () => {
	const harness = createMockHarness();
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
	const getCompletions = harness.commands["classifier-model"].getArgumentCompletions;

	// clear 后跟随空格：提供 3 个目标，value 拼装完整前缀
	const cSpace = getCompletions("clear ");
	assert.strictEqual(cSpace?.length, 3);
	assert.deepStrictEqual(
		cSpace.map((i: any) => i.value),
		["clear --stage1", "clear --stage2", "clear --both"],
	);

	// clear --stage1 后跟随空格：仅剩 clear --stage1 --stage2（排除已用的 stage1 与互斥的 both）
	const cStage1 = getCompletions("clear --stage1 ");
	assert.strictEqual(cStage1?.length, 1);
	assert.strictEqual(cStage1[0].value, "clear --stage1 --stage2");

	// clear --both 后跟随空格：无候选
	assert.strictEqual(getCompletions("clear --both "), null);

	// clear 后面出现模型值等非法 token：不提供候选
	assert.strictEqual(getCompletions("clear test/stage1 "), null);
});

test("Completion: 模型值补全、D3 描述与当前生效 ✓ 标注", async () => {
	const harness = createMockHarness();
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
	await harness.commands["classifier-model"].handler("clear", harness.ctx);
	// 预设 Stage 1 为 test/stage1
	await harness.commands["classifier-model"].handler("--stage1 test/stage1", harness.ctx);

	const getCompletions = harness.commands["classifier-model"].getArgumentCompletions;

	// --stage1 空格：列出全部模型，value 为 --stage1 <ref>，label 为 <ref>
	const stage1Models = getCompletions("--stage1 ");
	assert.ok(Array.isArray(stage1Models));
	assert.strictEqual(stage1Models.length, 4);

	const m1Item = stage1Models.find((i: any) => i.label === "test/stage1");
	assert.ok(m1Item);
	assert.strictEqual(m1Item.value, "--stage1 test/stage1");
	// 此时 Stage 1 当前生效正是 test/stage1，描述必须带有 ✓ 标注
	assert.match(m1Item.description, /^✓ \$0.3\/\$1.2 per M · reasoning · 1M ctx/);

	// 此时 Stage 2 未配置，回退到主模型 ctx/main，test/stage2 不带 ✓ 标记
	const m2Item = stage1Models.find((i: any) => i.label === "test/stage2");
	assert.ok(m2Item);
	assert.doesNotMatch(m2Item.description, /^✓/);

	// 前缀匹配过滤：--stage1 test/stage2
	const filtered = getCompletions("--stage1 test/stage2");
	assert.strictEqual(filtered?.length, 1);
	assert.strictEqual(filtered[0].label, "test/stage2");
});

test("Completion: 成对后的后续 flag 补全（SET_FLAG）与互斥剪枝", async () => {
	const harness = createMockHarness();
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
	const getCompletions = harness.commands["classifier-model"].getArgumentCompletions;

	// --stage1 <model> 完整输入后加空格：候选仅 --stage2（排除了 --stage1 与 --both）
	const afterStage1 = getCompletions("--stage1 test/stage1 ");
	assert.strictEqual(afterStage1?.length, 1);
	assert.strictEqual(afterStage1[0].value, "--stage1 test/stage1 --stage2");
	assert.strictEqual(afterStage1[0].label, "--stage2");

	// 随后输入第二个 flag 的模型值
	const afterTwoFlags = getCompletions("--stage1 test/stage1 --stage2 ");
	assert.ok(Array.isArray(afterTwoFlags));
	assert.strictEqual(afterTwoFlags.length, 4);
	assert.strictEqual(afterTwoFlags[0].value.startsWith("--stage1 test/stage1 --stage2 "), true);

	// --both <model> 完整输入后加空格：--both 独占，后续候选为 null
	assert.strictEqual(getCompletions("--both test/stage1 "), null);
});

test("E2E: 运行时闭包即时生效与裸 ID 匹配支持", async () => {
	const harness = createMockHarness();
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
	await harness.commands["classifier-model"].handler("clear", harness.ctx);

	// 1. 裸 ID 匹配：--stage1 stage1（不带 slash，通过 getAll 按 id 匹配）
	await harness.commands["classifier-model"].handler("--stage1 stage1", harness.ctx);
	const cfg = readGlobalConfigFile();
	assert.strictEqual(cfg.classifierStage1Model, "stage1");

	// 立即查询状态，验证闭包即时生效，Stage 1 生效为 test/stage1
	await harness.commands["classifier-model"].handler("", harness.ctx);
	let last = harness.notifySpy[harness.notifySpy.length - 1];
	assert.match(last.message, /Stage 1: 配置值 stage1 → 生效值 test\/stage1/);

	// 2. 设置 --both test/stage1 后，两阶段均即时生效（回退链取得共享配置值）
	await harness.commands["classifier-model"].handler("--both test/stage1", harness.ctx);
	await harness.commands["classifier-model"].handler("", harness.ctx);
	last = harness.notifySpy[harness.notifySpy.length - 1];
	assert.match(last.message, /Stage 1: 配置值 test\/stage1 → 生效值 test\/stage1/);
	assert.match(last.message, /Stage 2: 配置值 test\/stage1 → 生效值 test\/stage1/);
});

test("Completion: 边缘 Case（连续空格、--both 补全、非法输入、空库）", async () => {
	const harness = createMockHarness();
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
	const getCompletions = harness.commands["classifier-model"].getArgumentCompletions;

	// 1. 连续多空格：--stage1   test/stage1   --stage2 
	const multiSpace = getCompletions("--stage1   test/stage1   --stage2 ");
	assert.ok(Array.isArray(multiSpace));
	assert.strictEqual(multiSpace.length, 4);

	// 2. 非法 flag 之后按空格：无法识别，返回 null
	assert.strictEqual(getCompletions("--invalid-flag "), null);
	assert.strictEqual(getCompletions("--stage1 test/stage1 --invalid-flag "), null);

	// 3. --both 补全：候选项为全部模型列表
	await harness.commands["classifier-model"].handler("clear", harness.ctx);
	const bothModels = getCompletions("--both ");
	assert.ok(Array.isArray(bothModels));
	assert.strictEqual(bothModels.length, 4);
	assert.strictEqual(bothModels[0].value.startsWith("--both "), true);

	// 4. 空模型注册表：返回 null
	const emptyHarness = createMockHarness();
	emptyHarness.ctx.modelRegistry = {
		find: () => null,
		getAll: () => [],
		hasConfiguredAuth: () => false,
	};
	await emptyHarness.handlers["session_start"]({ reason: "start" }, emptyHarness.ctx);
	assert.strictEqual(emptyHarness.commands["classifier-model"].getArgumentCompletions("--stage1 "), null);
});

