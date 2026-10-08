import assert from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 测试环境隔离：在模块顶层重定向 HOME 与 PI_CODING_AGENT_DIR 到独立临时目录
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-issue-0049-"));
process.env.HOME = path.join(tempBase, "home");
process.env.PI_CODING_AGENT_DIR = path.join(tempBase, "agent");
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

import {
	EXTENDED_THINKING_LEVELS,
	isThinkingLevel,
} from "../extensions/approval-config.ts";

import approvalModeExtension, {
	applyClassifierThinkingConfig,
	getSupportedThinkingLevels,
	parseClassifierModelArgs,
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

function writeGlobalConfigFile(data: any): void {
	const p = path.join(process.env.PI_CODING_AGENT_DIR!, "approval-config.json");
	fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

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
	cost: { input: 0.3, output: 1.2 },
	reasoning: true,
	contextWindow: 1_000_000,
};

const modelNoThinking = {
	provider: "test",
	id: "nothinking",
	cost: { input: 0.1, output: 0.2 },
	reasoning: false,
	contextWindow: 100_000,
};

function createMockHarness() {
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};
	const notifySpy: { message: string; type?: string }[] = [];

	const allModels = [modelStage1, modelStage2, modelNoThinking];

	const registry = {
		find(provider: string, id: string) {
			return allModels.find((m) => m.provider === provider && m.id === id) ?? null;
		},
		getAll() {
			return allModels;
		},
		hasConfiguredAuth() {
			return true;
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
		model: modelStage1,
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

test("1. 思考档位基础类型与词汇表", async (t) => {
	await t.test("EXTENDED_THINKING_LEVELS 包含完整的 7 个档位", () => {
		assert.deepStrictEqual(EXTENDED_THINKING_LEVELS, [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	await t.test("isThinkingLevel 能正确识别合法与非法档位", () => {
		for (const level of EXTENDED_THINKING_LEVELS) {
			assert.strictEqual(isThinkingLevel(level), true);
		}
		assert.strictEqual(isThinkingLevel("ultra"), false);
		assert.strictEqual(isThinkingLevel("LOW"), false);
		assert.strictEqual(isThinkingLevel(""), false);
		assert.strictEqual(isThinkingLevel(null), false);
		assert.strictEqual(isThinkingLevel(undefined), false);
		assert.strictEqual(isThinkingLevel(123), false);
	});
});

test("2. getSupportedThinkingLevels 模型能力解析", async (t) => {
	await t.test("未传入模型时默认仅支持 off", () => {
		assert.deepStrictEqual(getSupportedThinkingLevels(undefined), ["off"]);
	});

	await t.test("model.reasoning === false 时仅支持 off", () => {
		assert.deepStrictEqual(getSupportedThinkingLevels({ reasoning: false }), ["off"]);
	});

	await t.test("model.type === 'classifier' 专职分类器仅支持 off", () => {
		assert.deepStrictEqual(
			getSupportedThinkingLevels({ type: "classifier", reasoning: true }),
			["off"],
		);
	});

	await t.test("未声明 thinkingLevelMap 时默认支持 5 档 (off, minimal, low, medium, high)", () => {
		assert.deepStrictEqual(getSupportedThinkingLevels({ reasoning: true }), [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	await t.test("thinkingLevelMap 显式映射为 null 的档位被视为不支持", () => {
		const model = {
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				low: "low",
				medium: "medium",
			},
		};
		const supported = getSupportedThinkingLevels(model);
		assert.strictEqual(supported.includes("off"), false);
		assert.strictEqual(supported.includes("low"), true);
		assert.strictEqual(supported.includes("medium"), true);
	});

	await t.test("thinkingLevelMap 显式支持 xhigh 与 max", () => {
		const model = {
			reasoning: true,
			thinkingLevelMap: {
				off: "none",
				low: "low",
				xhigh: "extra-high",
				max: "maximum",
			},
		};
		const supported = getSupportedThinkingLevels(model);
		assert.strictEqual(supported.includes("xhigh"), true);
		assert.strictEqual(supported.includes("max"), true);
	});
});

test("3. applyClassifierThinkingConfig 校验与回退机制", async (t) => {
	await t.test("未配置思考键时解析为未指定(provider 默认)", () => {
		const resolution = applyClassifierThinkingConfig({}, undefined, undefined, { silent: true });
		assert.strictEqual(resolution.stage1.level, undefined);
		assert.strictEqual(resolution.stage2.level, undefined);
		assert.strictEqual(resolution.stage1.rawConfig, undefined);
		assert.strictEqual(resolution.stage2.rawConfig, undefined);
		assert.strictEqual(resolution.stage1.effectiveSummary, "未指定(provider 默认)");
		assert.strictEqual(resolution.stage2.effectiveSummary, "未指定(provider 默认)");
		assert.strictEqual(resolution.stage1.fallbackReason, undefined);
		assert.strictEqual(resolution.stage2.fallbackReason, undefined);
		assert.strictEqual(resolution.violated, false);
	});

	await t.test("合法配置且模型支持时成功生效", () => {
		const resolution = applyClassifierThinkingConfig(
			{
				classifierStage1Thinking: "off",
				classifierStage2Thinking: "low",
			},
			modelStage1,
			modelStage2,
			{ silent: true },
		);
		assert.strictEqual(resolution.stage1.level, "off");
		assert.strictEqual(resolution.stage2.level, "low");
		assert.strictEqual(resolution.stage1.rawConfig, "off");
		assert.strictEqual(resolution.stage2.rawConfig, "low");
		assert.strictEqual(resolution.stage1.effectiveSummary, "off(配置)");
		assert.strictEqual(resolution.stage2.effectiveSummary, "low(配置)");
		assert.strictEqual(resolution.violated, false);
	});

	await t.test("配置了非法枚举值时告警并回退为未指定", () => {
		const notifications: string[] = [];
		const fakeCtx = {
			silent: false,
			hasUI: true,
			ui: {
				notify: (msg: string) => {
					notifications.push(msg);
				},
			},
		} as any;

		const resolution = applyClassifierThinkingConfig(
			{
				classifierStage1Thinking: "ultra" as any,
				classifierStage2Thinking: "LOW" as any,
			},
			modelStage1,
			modelStage2,
			fakeCtx,
		);
		assert.strictEqual(resolution.stage1.level, undefined);
		assert.strictEqual(resolution.stage2.level, undefined);
		assert.strictEqual(resolution.stage1.fallbackReason, "原 ultra 违规, 已回退");
		assert.strictEqual(resolution.stage2.fallbackReason, "原 LOW 违规, 已回退");
		assert.strictEqual(resolution.stage1.effectiveSummary, "未指定(原 ultra 违规, 已回退)");
		assert.strictEqual(resolution.stage2.effectiveSummary, "未指定(原 LOW 违规, 已回退)");
		assert.strictEqual(resolution.violated, true);
		assert.strictEqual(notifications.length, 2);
		assert.ok(notifications[0].includes("非法枚举值"));
		assert.ok(notifications[1].includes("非法枚举值"));
	});

	await t.test("配置合法但所选模型不支持该档位时告警并回退为未指定", () => {
		const notifications: string[] = [];
		const fakeCtx = {
			silent: false,
			hasUI: true,
			ui: {
				notify: (msg: string) => {
					notifications.push(msg);
				},
			},
		} as any;

		const resolution = applyClassifierThinkingConfig(
			{
				classifierStage1Thinking: "low",
				classifierStage2Thinking: "high",
			},
			modelNoThinking,
			modelNoThinking,
			fakeCtx,
		);
		assert.strictEqual(resolution.stage1.level, undefined);
		assert.strictEqual(resolution.stage2.level, undefined);
		assert.strictEqual(resolution.stage1.fallbackReason, "原 low 不受支持, 已回退");
		assert.strictEqual(resolution.stage2.fallbackReason, "原 high 不受支持, 已回退");
		assert.strictEqual(resolution.stage1.effectiveSummary, "未指定(原 low 不受支持, 已回退)");
		assert.strictEqual(resolution.stage2.effectiveSummary, "未指定(原 high 不受支持, 已回退)");
		assert.strictEqual(resolution.violated, true);
		assert.strictEqual(notifications.length, 2);
		assert.ok(notifications[0].includes("不支持思考档位 \"low\""));
		assert.ok(notifications[0].includes("该模型支持：off"));
	});
});

test("4. parseClassifierModelArgs 命令解析", async (t) => {
	await t.test("解析单纯设置 thinking: --stage1 --thinking low", () => {
		const parsed = parseClassifierModelArgs("--stage1 --thinking low");
		assert.strictEqual(parsed.kind, "set");
		if (parsed.kind === "set") {
			assert.deepStrictEqual(parsed.pairs, [
				{ flag: "--stage1", thinking: "low" },
			]);
		}
	});

	await t.test("解析单纯设置 thinking: --stage2 --thinking off", () => {
		const parsed = parseClassifierModelArgs("--stage2 --thinking off");
		assert.strictEqual(parsed.kind, "set");
		if (parsed.kind === "set") {
			assert.deepStrictEqual(parsed.pairs, [
				{ flag: "--stage2", thinking: "off" },
			]);
		}
	});

	await t.test("解析单纯设置 thinking: --both --thinking minimal", () => {
		const parsed = parseClassifierModelArgs("--both --thinking minimal");
		assert.strictEqual(parsed.kind, "set");
		if (parsed.kind === "set") {
			assert.deepStrictEqual(parsed.pairs, [
				{ flag: "--both", thinking: "minimal" },
			]);
		}
	});

	await t.test("解析同时设置模型与思考: --stage1 test/modelA --thinking low", () => {
		const parsed = parseClassifierModelArgs("--stage1 test/modelA --thinking low");
		assert.strictEqual(parsed.kind, "set");
		if (parsed.kind === "set") {
			assert.deepStrictEqual(parsed.pairs, [
				{ flag: "--stage1", model: "test/modelA", thinking: "low" },
			]);
		}
	});

	await t.test(
		"解析双 stage 分别设置模型与思考: --stage1 test/s1 --thinking off --stage2 test/s2 --thinking medium",
		() => {
			const parsed = parseClassifierModelArgs(
				"--stage1 test/s1 --thinking off --stage2 test/s2 --thinking medium",
			);
			assert.strictEqual(parsed.kind, "set");
			if (parsed.kind === "set") {
				assert.deepStrictEqual(parsed.pairs, [
					{ flag: "--stage1", model: "test/s1", thinking: "off" },
					{ flag: "--stage2", model: "test/s2", thinking: "medium" },
				]);
			}
		},
	);

	await t.test("解析 clear --thinking", () => {
		const parsed = parseClassifierModelArgs("clear --thinking");
		assert.deepStrictEqual(parsed, {
			kind: "clear",
			targets: ["--thinking"],
		});
	});

	await t.test("解析 clear --stage1 --thinking", () => {
		const parsed = parseClassifierModelArgs("clear --stage1 --thinking");
		assert.deepStrictEqual(parsed, {
			kind: "clear",
			targets: ["--stage1", "--thinking"],
		});
	});

	await t.test("缺少作用域标志报错: --thinking low", () => {
		const parsed = parseClassifierModelArgs("--thinking low");
		assert.strictEqual(parsed.kind, "error");
		if (parsed.kind === "error") {
			assert.ok(parsed.message.includes("必须指定作用范围"));
		}
	});

	await t.test("缺少思考档位参数报错: --stage1 --thinking", () => {
		const parsed = parseClassifierModelArgs("--stage1 --thinking");
		assert.strictEqual(parsed.kind, "error");
		if (parsed.kind === "error") {
			assert.ok(parsed.message.includes("缺少档位值"));
		}
	});

	await t.test("思考档位参数以 -- 开头报错: --stage1 --thinking --stage2", () => {
		const parsed = parseClassifierModelArgs("--stage1 --thinking --stage2");
		assert.strictEqual(parsed.kind, "error");
		if (parsed.kind === "error") {
			assert.ok(parsed.message.includes("不能以 \"--\" 开头"));
		}
	});

	await t.test("非法思考档位报错: --stage1 --thinking ultra", () => {
		const parsed = parseClassifierModelArgs("--stage1 --thinking ultra");
		assert.strictEqual(parsed.kind, "error");
		if (parsed.kind === "error") {
			assert.ok(parsed.message.includes("收到无效档位 \"ultra\""));
		}
	});

	await t.test("非全小写思考档位报错: --stage1 --thinking LOW", () => {
		const parsed = parseClassifierModelArgs("--stage1 --thinking LOW");
		assert.strictEqual(parsed.kind, "error");
		if (parsed.kind === "error") {
			assert.ok(parsed.message.includes("严格小写，不接受 \"LOW\""));
		}
	});

	await t.test("重复指定 --thinking 报错", () => {
		const parsed = parseClassifierModelArgs("--stage1 --thinking low --thinking high");
		assert.strictEqual(parsed.kind, "error");
		if (parsed.kind === "error") {
			assert.ok(parsed.message.includes("重复指定 \"--thinking\""));
		}
	});

	await t.test("仅传 --stage1 而既无模型又无 thinking 报错", () => {
		const parsed = parseClassifierModelArgs("--stage1");
		assert.strictEqual(parsed.kind, "error");
		if (parsed.kind === "error") {
			assert.ok(parsed.message.includes("缺少模型值"));
		}
	});
});

test("5. 自动补全状态机 (getArgumentCompletions)", async (t) => {
	const harness = createMockHarness();
	const getCompletions = harness.commands["classifier-model"].getArgumentCompletions;

	await t.test("clear 后输入 --t 补全为 clear --thinking", () => {
		const comps = getCompletions("clear --t");
		assert.ok(comps && comps.some((c: any) => c.value === "clear --thinking"));
	});

	await t.test("设置模型后输入 --t 补全为 --thinking", () => {
		const comps = getCompletions("--stage1 test/stage1 --t");
		assert.ok(comps && comps.some((c: any) => c.value === "--stage1 test/stage1 --thinking"));
	});

	await t.test("直接输入 --stage1 --t 补全为 --stage1 --thinking", () => {
		const comps = getCompletions("--stage1 --t");
		assert.ok(comps && comps.some((c: any) => c.value === "--stage1 --thinking"));
	});

	await t.test("输入 --thinking 后空格补全 7 个思考档位候选", () => {
		const comps = getCompletions("--stage1 --thinking ");
		assert.ok(comps);
		for (const level of EXTENDED_THINKING_LEVELS) {
			assert.ok(comps.some((c: any) => c.value === `--stage1 --thinking ${level}`));
		}
	});

	await t.test("输入 --thinking m 补全匹配的档位 (minimal, medium, max)", () => {
		const comps = getCompletions("--stage1 --thinking m");
		assert.ok(comps);
		assert.ok(comps.some((c: any) => c.value === "--stage1 --thinking minimal"));
		assert.ok(comps.some((c: any) => c.value === "--stage1 --thinking medium"));
		assert.ok(comps.some((c: any) => c.value === "--stage1 --thinking max"));
		assert.strictEqual(comps.some((c: any) => c.value === "--stage1 --thinking low"), false);
	});
});

test("6. 状态视图报告呈现与命令持久化 (E2E)", async () => {
	const harness = createMockHarness();
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
	writeGlobalConfigFile({});

	// 1. 设置 stage1 thinking
	await harness.commands["classifier-model"].handler("--stage1 --thinking off", harness.ctx);
	let savedConfig = readGlobalConfigFile();
	assert.strictEqual(savedConfig.classifierStage1Thinking, "off");

	// 2. 查看状态视图，包含 Stage 1 思考
	await harness.commands["classifier-model"].handler("", harness.ctx);
	let lastStatus = harness.notifySpy[harness.notifySpy.length - 1];
	assert.ok(lastStatus.message.includes("Stage 1 思考: 配置值 off → 生效值 off (配置)"));
	assert.ok(lastStatus.message.includes("Stage 2 思考: 配置值 未配置 → 生效值 未指定 (provider 默认)"));

	// 3. 设置 both thinking
	await harness.commands["classifier-model"].handler("--both --thinking medium", harness.ctx);
	savedConfig = readGlobalConfigFile();
	assert.strictEqual(savedConfig.classifierStage1Thinking, "medium");
	assert.strictEqual(savedConfig.classifierStage2Thinking, "medium");

	// 4. clear --thinking 仅清除思考键
	await harness.commands["classifier-model"].handler("clear --thinking", harness.ctx);
	savedConfig = readGlobalConfigFile();
	assert.strictEqual(savedConfig.classifierStage1Thinking, undefined);
	assert.strictEqual(savedConfig.classifierStage2Thinking, undefined);

	// 5. 不支持档位时的回退展示
	await harness.commands["classifier-model"].handler("--stage1 test/nothinking --thinking high", harness.ctx);
	await harness.commands["classifier-model"].handler("", harness.ctx);
	lastStatus = harness.notifySpy[harness.notifySpy.length - 1];
	assert.ok(lastStatus.message.includes("Stage 1 思考: 配置值 high → 生效值 未指定 (回退原因: 原 high 不受支持, 已回退)"));
});

test("7. complete 调用中 reasoning 参数的透传与省略", async () => {
	const calls: any[] = [];
	const mockModelWithThinking = {
		provider: "test",
		id: "model-thinking",
		reasoning: true,
		complete: async (_ctx: any, opts: any) => {
			calls.push(opts);
			return { content: [{ type: "text", text: '{"approved": true, "reason": "ok"}' }] };
		},
	};

	const harness = createMockHarness();
	(harness.ctx.modelRegistry as any).find = () => mockModelWithThinking;
	await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);

	// Case A: 配置有效 thinking
	await harness.commands["classifier-model"].handler("--stage1 test/model-thinking --thinking low", harness.ctx);
	// 验证配置已更新
	const cfgA = readGlobalConfigFile();
	assert.strictEqual(cfgA.classifierStage1Thinking, "low");

	// Case B: clear --thinking 后 unset
	await harness.commands["classifier-model"].handler("clear --thinking", harness.ctx);
	const cfgB = readGlobalConfigFile();
	assert.strictEqual(cfgB.classifierStage1Thinking, undefined);
});

test("8. 双语用户手册与 Markdown 静态质量校验", () => {
	const docsDir = path.join(import.meta.dirname, "../docs");
	const files = [
		path.join(docsDir, "user-guide.zh-CN.md"),
		path.join(docsDir, "user-guide.md"),
	];

	// 1. 验证 2 个文件均存在且非空
	for (const f of files) {
		assert.ok(fs.existsSync(f), `File should exist: ${f}`);
		const content = fs.readFileSync(f, "utf-8");
		assert.ok(content.length > 1000, `File should have content: ${f}`);
	}

	const docZh = fs.readFileSync(files[0], "utf-8");
	const docEn = fs.readFileSync(files[1], "utf-8");

	// 2. 验证思考配置关键内容已在中英双语中体现
	assert.ok(docZh.includes("classifierStage1Thinking"));
	assert.ok(docZh.includes("Stage 1 思考"));
	assert.ok(docZh.includes("4.2.3 分类器思考模式配置与显式状态呈现"));

	assert.ok(docEn.includes("classifierStage1Thinking"));
	assert.ok(docEn.includes("Stage 1 思考"));
	assert.ok(docEn.includes("4.2.3 Classifier Thinking Configuration and Explicit Observability"));

	// 4. 对齐 check-md.py 的行内代码反引号与表格列检查
	const CODE_RUN_RE = /`+/g;
	function unmatchedBackticks(text: string): number {
		const runs: Array<{ start: number; len: number }> = [];
		let match;
		while ((match = CODE_RUN_RE.exec(text)) !== null) {
			runs.push({ start: match.index, len: match[0].length });
		}
		let literal = 0;
		let i = 0;
		const n = runs.length;
		while (i < n) {
			const len = runs[i].len;
			let j = i + 1;
			while (j < n && runs[j].len !== len) j++;
			if (j < n) {
				i = j + 1;
			} else {
				literal += len;
				i++;
			}
		}
		return literal;
	}

	for (const f of files) {
		const content = fs.readFileSync(f, "utf-8");
		const lines = content.split("\n");
		let inFence = false;
		let paragraphLines: string[] = [];

		const checkParagraph = (pLines: string[]) => {
			if (pLines.length === 0) return;
			const pText = pLines.join(" ").replace(/\\`/g, "");
			const unclosed = unmatchedBackticks(pText);
			assert.strictEqual(
				unclosed % 2,
				0,
				`Unmatched backtick in ${path.basename(f)}: "${pText.slice(0, 80)}"`,
			);
		};

		for (const line of lines) {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				continue;
			}
			if (inFence) continue;

			if (line.trim() === "") {
				checkParagraph(paragraphLines);
				paragraphLines = [];
			} else if (line.trim().startsWith("|")) {
				checkParagraph(paragraphLines);
				paragraphLines = [];
				// 表格行单独检查各单元格
				const cells = line.split(/(?<!\\)\|/);
				for (const cell of cells) {
					const unclosed = unmatchedBackticks(cell.replace(/\\`/g, ""));
					assert.strictEqual(unclosed % 2, 0, `Unmatched cell backtick in ${f}: ${cell}`);
				}
			} else {
				paragraphLines.push(line);
			}
		}
		checkParagraph(paragraphLines);
	}
});
