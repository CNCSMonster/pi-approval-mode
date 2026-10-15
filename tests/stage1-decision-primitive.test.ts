import { test } from "node:test";
import assert from "node:assert";
import { parseStage1Decision } from "../extensions/approval-mode.ts";
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
