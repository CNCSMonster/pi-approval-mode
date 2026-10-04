import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import approvalModeExtension from "../extensions/approval-mode.ts";

function createMockEnv() {
	const isolatedHome = mkdtempSync(join(tmpdir(), "pi-issue-0040-41-home-"));
	const isolatedWorkspace = mkdtempSync(join(tmpdir(), "pi-issue-0040-41-ws-"));
	process.env.HOME = isolatedHome;
	process.env.USERPROFILE = isolatedHome;
	const agentDir = join(isolatedHome, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(isolatedWorkspace, ".pi"), { recursive: true });

	process.env.PI_CODING_AGENT_DIR = agentDir;

	const handlers: Record<string, Function> = {};
	const commands: Record<string, { handler: Function; getArgumentCompletions?: Function }> = {};
	const notifySpy: Array<{ message: string; type?: string }> = [];

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
		getFlag: (name: string) => (name === "approval-mode" ? "yolo" : undefined),
	};

	approvalModeExtension(pi);

	const defaultMainModel = {
		id: "main-model",
		provider: "test-provider",
		name: "Main Model",
	};

	const ctx: any = {
		modelRegistry: {
			find: (_provider: string, id: string) => ({ id, provider: "test", name: id }),
			getAll: () => [{ id: "main-model", provider: "test-provider", name: "Main Model" }],
			refresh: async () => {},
			hasConfiguredAuth: () => true,
		},
		model: defaultMainModel,
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => {
				notifySpy.push({ message, type });
			},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t },
		},
		cwd: isolatedWorkspace,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	return { handlers, commands, notifySpy, ctx, agentDir, isolatedWorkspace };
}

test("session_start/reload 删配置项后变量与阈值精确复位", async () => {
	const { handlers, commands, ctx, agentDir, isolatedWorkspace: _isolatedWorkspace } = createMockEnv();

	// 1. 写入初始包含自定义项的配置
	const initialConfig = {
		classifierModel: "test/custom-classifier",
		classifierStage1Model: "test/custom-stage1",
		classifierStage2Model: "test/custom-stage2",
		loopDetection: {
			identicalThreshold: 5,
			denialThreshold: 6,
			stagnationThreshold: 8,
			hardLimitMultiplier: 4,
		},
		denialLimits: {
			maxConsecutiveBlock: 7,
			maxConsecutiveUnavailable: 8,
			maxTotalDenials: 40,
		},
		headlessAbortOnDenialCap: true,
	};

	writeFileSync(join(agentDir, "approval-config.json"), JSON.stringify(initialConfig, null, 2));

	// 触发 session_start
	await handlers["session_start"]({ reason: "start" }, ctx);

	// 验证自定义分类器模型已生效（通过 /classifier-model 输出查看）
	let statusOutput = "";
	ctx.ui.notify = (msg: string) => {
		statusOutput = msg;
	};
	await commands["classifier-model"].handler("", ctx);
	assert.match(statusOutput, /custom-stage1/);
	assert.match(statusOutput, /custom-stage2/);

	// 2. 模拟用户删除了所有这些配置项（清空配置）
	writeFileSync(join(agentDir, "approval-config.json"), JSON.stringify({}, null, 2));

	// 触发 reload
	await handlers["session_start"]({ reason: "reload" }, ctx);

	// 3. 验证分类器模型已被清空回落（显示默认链/未配置）
	await commands["classifier-model"].handler("", ctx);
	assert.match(statusOutput, /未配置/);
	assert.doesNotMatch(statusOutput, /custom-classifier/);
	assert.doesNotMatch(statusOutput, /custom-stage1/);
	assert.doesNotMatch(statusOutput, /custom-stage2/);
});

test("切换至未受信项目时阻断项目配置并复位，不泄漏上一项目配置", async () => {
	const { handlers, commands, ctx, isolatedWorkspace } = createMockEnv();

	// 在项目目录写入项目配置
	writeFileSync(
		join(isolatedWorkspace, ".pi", "approval-config.json"),
		JSON.stringify({
			classifierModel: "test/project-model",
		}, null, 2),
	);

	// 先在受信状态下加载
	ctx.isProjectTrusted = () => true;
	await handlers["session_start"]({ reason: "start" }, ctx);

	let statusOutput = "";
	ctx.ui.notify = (msg: string) => {
		statusOutput = msg;
	};
	await commands["classifier-model"].handler("", ctx);
	assert.match(statusOutput, /project-model/);

	// 现在项目变为未受信任（isProjectTrusted = false）
	ctx.isProjectTrusted = () => false;
	await handlers["session_start"]({ reason: "reload" }, ctx);

	// 验证项目配置被信任闸拦截，且运行时已复位，不残留 project-model
	await commands["classifier-model"].handler("", ctx);
	assert.doesNotMatch(statusOutput, /project-model/);
	assert.match(statusOutput, /未配置/);
});

test("yolo 模式行为锁定——常规放行，但显式 deny 与 loop 熔断依然绝对拦截", async () => {
	const { handlers, ctx, agentDir } = createMockEnv();

	// 写入全局 deny 规则：Deny(Bash(curl *))
	writeFileSync(
		join(agentDir, "approval-rules.json"),
		JSON.stringify({
			allow: [],
			ask: [],
			deny: ["Bash(curl *)"],
			default: [],
		}),
	);

	// 启动，当前已设为 yolo 模式
	await handlers["session_start"]({ reason: "start" }, ctx);

	const toolCall = handlers["tool_call"];
	assert.ok(toolCall, "tool_call handler 必须存在");

	// 1. 常规 bash 调用 -> yolo 模式直接放行 (return undefined)
	const allowRes = await toolCall(
		{
			toolName: "bash",
			input: { command: "echo normal_operation" },
		},
		ctx,
	);
	assert.deepStrictEqual(allowRes, undefined, "常规工具调用在 yolo 下应直接放行 (return undefined)");

	// 2. 命中显式 deny 规则 -> yolo 模式依然被拦截 (Deny-First)
	const denyRes = await toolCall(
		{
			toolName: "bash",
			input: { command: "curl http://malicious.test" },
		},
		ctx,
	);
	assert.ok(denyRes && denyRes.block, "显式 deny 规则在 yolo 模式下必须拦截");
	assert.match(denyRes.reason, /Bash\(curl \*\)/);

	// 3. 死循环重复相同调用 -> 无头语境下在 yolo 模式中依然被 LoopDetector 熔断
	ctx.hasUI = false;
	const loopInput = { command: "ls -la /tmp/loop-test" };
	await toolCall({ toolName: "bash", input: loopInput }, ctx); // 第 1 次 放行
	await toolCall({ toolName: "bash", input: loopInput }, ctx); // 第 2 次 放行
	const loopRes = await toolCall({ toolName: "bash", input: loopInput }, ctx); // 第 3 次 熔断拦截

	assert.ok(loopRes && loopRes.block, "连续 3 次相同调用在 yolo 模式下必须被死循环熔断拦截");
	assert.match(loopRes.reason, /loop|circuit/i);
});
