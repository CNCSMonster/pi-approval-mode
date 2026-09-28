import test from "node:test";
import assert from "node:assert/strict";
import {
	SECURITY_POLICY_RULES,
	CLASSIFIER_BASE_PROMPT,
	fallbackHeuristicCheck,
	isProtectedPath,
} from "../extensions/heuristic-guard.ts";

test("分类器与启发式单一来源 - 动态 Prompt 生成完整性", () => {
	assert.ok(CLASSIFIER_BASE_PROMPT.includes("## Default ALLOW (Normally Safe)"));
	assert.ok(CLASSIFIER_BASE_PROMPT.includes("## Default SOFT BLOCK"));
	assert.ok(CLASSIFIER_BASE_PROMPT.includes("## Default HARD BLOCK"));
	assert.ok(CLASSIFIER_BASE_PROMPT.includes("## Decision principles"));

	// 确认所有注册在 SECURITY_POLICY_RULES 的 promptText 均呈现在最终 Prompt 中
	for (const rule of SECURITY_POLICY_RULES) {
		assert.ok(
			CLASSIFIER_BASE_PROMPT.includes(rule.promptText),
			`规则 ${rule.id} 的 promptText 未包含在 CLASSIFIER_BASE_PROMPT 中`,
		);
	}
});

test("分类器与启发式单一来源 - 双向无漂移断言 (ALLOW 正例绝不被启发式兜底拦截)", () => {
	const allowRules = SECURITY_POLICY_RULES.filter((r) => r.category === "allow");

	for (const rule of allowRules) {
		if (!rule.positiveSamples) continue;

		for (const sample of rule.positiveSamples) {
			const check = fallbackHeuristicCheck("bash", { command: sample });
			assert.equal(
				check.shouldBlock,
				false,
				`【语义漂移致命冲突】规则 "${rule.id}" 在分类器提示词中被声明为 Default ALLOW，但正例 "${sample}" 却被离线启发式兜底判定为阻断 (reason: ${check.reason})！`,
			);
		}
	}
});

test("分类器与启发式单一来源 - 双向无漂移断言 (BLOCK 反例在启发式中必须被精准拦截)", () => {
	const blockRules = SECURITY_POLICY_RULES.filter(
		(r) => r.category === "soft_block" || r.category === "hard_block",
	);

	for (const rule of blockRules) {
		// 1. 命令级反例校验
		if (rule.negativeSamples) {
			for (const cmd of rule.negativeSamples) {
				const check = fallbackHeuristicCheck("bash", { command: cmd });
				assert.equal(
					check.shouldBlock,
					true,
					`【安全兜底缺失】规则 "${rule.id}" 在分类器提示词中被声明为高危 ${rule.category}，但其破坏性命令反例 "${cmd}" 未能被启发式规则有效拦截！`,
				);
			}
		}

		// 2. 路径级反例校验
		if (rule.negativePathSamples) {
			for (const path of rule.negativePathSamples) {
				assert.equal(
					isProtectedPath(path),
					true,
					`【敏感路径兜底缺失】规则 "${rule.id}" 中的受保护敏感路径 "${path}" 未能被 isProtectedPath 拦截！`,
				);
			}
		}
	}
});
