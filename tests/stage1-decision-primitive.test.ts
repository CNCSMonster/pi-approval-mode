import { test } from "node:test";
import assert from "node:assert";
import { parseStage1Decision } from "../extensions/approval-mode.ts";
import {
	CLASSIFIER_BASE_PROMPT,
	buildClassifierBasePrompt,
} from "../extensions/heuristic-guard.ts";
import {
	interpretStage1Result,
	STAGE1_QUESTION_KEY,
	buildStage1ClassifierContext,
} from "../extensions/stage1-classifier.ts";

test("Stage 1 决策原语: parseStage1Decision 解析标准原语与双向兼容", () => {
	// 1. 标准决策原语 ALLOW / DENY
	assert.deepStrictEqual(parseStage1Decision({ decision: "ALLOW" }), { ok: true, shouldBlock: false });
	assert.deepStrictEqual(parseStage1Decision({ decision: "allow" }), { ok: true, shouldBlock: false });
	assert.deepStrictEqual(parseStage1Decision({ decision: "  ALLOW  " }), { ok: true, shouldBlock: false });
	assert.deepStrictEqual(parseStage1Decision({ decision: "DENY" }), { ok: true, shouldBlock: true });
	assert.deepStrictEqual(parseStage1Decision({ decision: "deny" }), { ok: true, shouldBlock: true });

	// 2. 淘汰原语 BLOCK 向后兼容为 DENY / shouldBlock: true
	assert.deepStrictEqual(parseStage1Decision({ decision: "BLOCK" }), { ok: true, shouldBlock: true });
	assert.deepStrictEqual(parseStage1Decision({ decision: "block" }), { ok: true, shouldBlock: true });

	// 3. 兼容历史布尔形态 { "shouldBlock": boolean }
	assert.deepStrictEqual(parseStage1Decision({ shouldBlock: false }), { ok: true, shouldBlock: false });
	assert.deepStrictEqual(parseStage1Decision({ shouldBlock: true }), { ok: true, shouldBlock: true });

	// 4. 异常输入防御与非法值回退
	assert.deepStrictEqual(parseStage1Decision(null), { ok: false, shouldBlock: true });
	assert.deepStrictEqual(parseStage1Decision(undefined), { ok: false, shouldBlock: true });
	assert.deepStrictEqual(parseStage1Decision("ALLOW"), { ok: false, shouldBlock: true });
	assert.deepStrictEqual(parseStage1Decision({ decision: "UNKNOWN_STATE" }), { ok: false, shouldBlock: true });
	assert.deepStrictEqual(parseStage1Decision({}), { ok: false, shouldBlock: true });
});

test("Stage 1 决策原语: interpretStage1Result 支持 choice / decision 决策与概率判读", () => {
	// Choice 题型
	const choiceAllow = {
		stopReason: "stop",
		answers: { [STAGE1_QUESTION_KEY]: { type: "choice", choice: "ALLOW" } },
	};
	assert.deepStrictEqual(interpretStage1Result(choiceAllow), {
		ok: true,
		shouldBlock: false,
		probability: 0,
	});

	const choiceDeny = {
		stopReason: "stop",
		answers: { [STAGE1_QUESTION_KEY]: { type: "choice", choice: "DENY" } },
	};
	assert.deepStrictEqual(interpretStage1Result(choiceDeny), {
		ok: true,
		shouldBlock: true,
		probability: 1,
	});

	const choiceBlock = {
		stopReason: "stop",
		answers: { [STAGE1_QUESTION_KEY]: { type: "choice", choice: "BLOCK" } },
	};
	assert.deepStrictEqual(interpretStage1Result(choiceBlock), {
		ok: true,
		shouldBlock: true,
		probability: 1,
	});

	// Decision 标量题目键兼容
	const decisionAllow = {
		stopReason: "stop",
		answers: { decision: { decision: "ALLOW" } },
	};
	assert.deepStrictEqual(interpretStage1Result(decisionAllow), {
		ok: true,
		shouldBlock: false,
		probability: 0,
	});

	// 原生 bool 概率
	const boolPass = {
		stopReason: "stop",
		answers: { [STAGE1_QUESTION_KEY]: { type: "bool", probability: 0.1 } },
	};
	assert.deepStrictEqual(interpretStage1Result(boolPass), {
		ok: true,
		shouldBlock: false,
		probability: 0.1,
	});

	const boolBlock = {
		stopReason: "stop",
		answers: { [STAGE1_QUESTION_KEY]: { type: "bool", probability: 0.9 } },
	};
	assert.deepStrictEqual(interpretStage1Result(boolBlock), {
		ok: true,
		shouldBlock: true,
		probability: 0.9,
	});
});

test("Stage 1 提示词去偏置: 不含 Err on the side of blocking 且 instructions 客观", () => {
	const ctx = buildStage1ClassifierContext("Tool: bash\nArguments: ls");
	const q = ctx.questions[STAGE1_QUESTION_KEY];
	assert.ok(!q.instructions.includes("Err on the side of blocking"));
	assert.ok(q.instructions.includes("allowed or denied"));
	assert.ok(q.criteria.true.includes("deny"));
	assert.ok(q.criteria.false.includes("allow"));
});

test("共享基础提示词净化: 不含偏置句与 BLOCK 决策动词，响应格式归各阶段后缀声明", () => {
	const prompt = CLASSIFIER_BASE_PROMPT;

	// 偏置诱导句（含小写变体）不得残留
	assert.ok(!prompt.includes("Err on the side of blocking"), "不得包含 Err on the side of blocking 偏置句");
	assert.ok(!prompt.includes("err on the side of blocking"), "不得包含 err on the side of blocking 偏置句");

	// BLOCK/BLOCKED 作为决策动词一律不得残留（HARD/SOFT BLOCK 作为规则类目名不受限）
	assert.ok(!prompt.includes("BLOCKED"), "判定框架不得使用 BLOCKED 决策原语");
	assert.ok(!/\bblocked\b/.test(prompt), "决策原则不得以 blocked 表达拦截");
	assert.ok(!/\bblocking\b/.test(prompt), "决策原则不得以 blocking 表达拦截");

	// 判定框架统一为两态契约 ALLOW / DENY
	assert.ok(prompt.includes("ALLOWED or DENIED"), "判定框架必须为 ALLOWED or DENIED 两态契约");

	// 输出 schema 由各阶段后缀各自声明，基础提示词只承载策略内容与决策原则
	assert.ok(!prompt.includes("## Response format"), "基础提示词不得再声明 Response format 段");
	assert.ok(!prompt.includes("DECISION: ALLOW"), "基础提示词不得声明判决行格式");
	assert.ok(!prompt.includes("verdict"), "基础提示词不得声明 verdict 响应格式");

	// 中立客观的保守语义保持：常规无害才 ALLOW、不确定一律 DENY 上浮复核
	assert.ok(
		prompt.includes("Only grant ALLOW when confident the action is routine and harmless"),
		"须保留仅确信常规无害才 ALLOW 的中立原则",
	);
	assert.ok(
		prompt.includes("when uncertain, deny and escalate for review"),
		"须保留不确定即 DENY 上浮复核的 fail-closed 语义",
	);

	// 严格优先与不可逆风险上浮人审的语义不得随净化丢失
	assert.ok(prompt.includes("Irreversibility overrides helpfulness"), "须保留不可逆风险优先原则");
	assert.ok(
		prompt.includes("deny the action and escalate for user confirmation"),
		"不可逆风险须仍上浮人审（以 DENY 原语表达）",
	);
	const withPolicy = buildClassifierBasePrompt({ globalPolicy: "- g", projectPolicy: "- p" });
	assert.ok(
		withPolicy.includes("the stricter restriction MUST prevail (when in conflict, deny)"),
		"策略冲突时严格优先语义须以 DENY 原语表达",
	);
	assert.ok(!/\bblocking\b/.test(withPolicy), "策略注入后的优先级不变量也不得残留 blocking 决策动词");
});
