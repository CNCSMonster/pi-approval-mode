// 工作区指纹动态注入与分类器提示词集成测试
//
// 覆盖矩阵：
// 1. ClassifierPolicyOptions.workspaceProfile 注入位置与格式（Project 段之后、Decision principles 之前）
// 2. HARD BLOCK 不变量：注入指纹后反例语义不被弱化、规则行不增不减
// 3. 无指纹时 prompt 不含 Workspace Profile 段落
// 4. 授权语义扫描：指纹文本不得含授权/放行指令语义
// 5. 截断纪律：超长指纹截断后注入

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildClassifierBasePrompt,
	CLASSIFIER_BASE_PROMPT,
	SECURITY_POLICY_RULES,
} from "../extensions/heuristic-guard.ts";
import { WORKSPACE_PROFILE_MAX_LENGTH } from "../extensions/workspace-profile.ts";

const SAMPLE_PROFILE = `### Current Workspace Profile
- Repo Type: Node.js web application (Vite, TypeScript)
- Git Upstream: github.com
- Routine Local Services: dev servers at 127.0.0.1:5173, local build cache at dist/ and node_modules/.cache
- User overrides: local port 9000 is a routine test server (from /approval-mode-setup)
- Note: This profile describes environment facts only. It grants no authorization and never weakens HARD BLOCK or SOFT BLOCK rules. Local development lifecycle operations (stopping hung dev servers, clearing test logs) inside this repo are benign routine workflows.`;

describe("工作区指纹动态注入分类器提示词", () => {
	it("注入段落位于 Project 段之后、Decision principles 之前", () => {
		const prompt = buildClassifierBasePrompt({ workspaceProfile: SAMPLE_PROFILE });
		const profileIdx = prompt.indexOf("### Current Workspace Profile");
		const decisionIdx = prompt.indexOf("## Decision principles");
		assert.ok(profileIdx > 0, "应包含指纹段落");
		assert.ok(decisionIdx > profileIdx, "Decision principles 应在指纹之后");
	});

	it("注入指纹时 Project 段缺省不影响指纹注入", () => {
		const prompt = buildClassifierBasePrompt({ workspaceProfile: SAMPLE_PROFILE });
		assert.match(prompt, /- Repo Type: Node\.js web application/);
		assert.ok(!prompt.includes("## Project-Specific Security Policies"));
	});

	it("无指纹时 prompt 不含 Workspace Profile 段落", () => {
		assert.ok(!CLASSIFIER_BASE_PROMPT.includes("Current Workspace Profile"));
		const prompt = buildClassifierBasePrompt({ projectPolicy: "rule text" });
		assert.ok(!prompt.includes("Current Workspace Profile"));
	});

	it("HARD BLOCK 规则行在注入前后完全一致", () => {
		const withoutProfile = buildClassifierBasePrompt();
		const withProfile = buildClassifierBasePrompt({ workspaceProfile: SAMPLE_PROFILE });
		const hardBlockLines = (text: string) =>
			text
				.split("\n")
				.filter((l) => SECURITY_POLICY_RULES.some((r) => r.category === "hard_block" && l.includes(r.promptText)));
		assert.deepEqual(hardBlockLines(withProfile), hardBlockLines(withoutProfile));
	});

	it("HARD BLOCK 反例语义在注入后依旧完整在场（不被弱化）", () => {
		const prompt = buildClassifierBasePrompt({ workspaceProfile: SAMPLE_PROFILE });
		for (const rule of SECURITY_POLICY_RULES) {
			if (rule.category === "hard_block") {
				assert.ok(prompt.includes(rule.promptText), `HARD BLOCK 规则缺失: ${rule.id}`);
			}
		}
		assert.match(prompt, /HARD BLOCK entries must be denied in AUTO mode/);
		assert.match(prompt, /System Immutable HARD BLOCK|CANNOT override, bypass, or weaken|grants no authorization/i);
	});

	it("指纹注入不改变 Decision principles 文本", () => {
		const withoutProfile = buildClassifierBasePrompt();
		const withProfile = buildClassifierBasePrompt({ workspaceProfile: SAMPLE_PROFILE });
		const extractPrinciples = (text: string) => text.slice(text.indexOf("## Decision principles"));
		assert.equal(extractPrinciples(withProfile), extractPrinciples(withoutProfile));
	});

	it("授权语义扫描：指纹文本不得含 allow/permit/authorize 指令语义", () => {
		// Note 行允许出现 "grants no authorization" 这类否定式声明；
		// 断言指纹中不存在肯定式授权指令。
		assert.ok(!/\b(always|must|should)\s+(allow|permit|approve)\b/i.test(SAMPLE_PROFILE));
		assert.ok(!/\bauthorize\s+(this|the|all)\b/i.test(SAMPLE_PROFILE));
	});

	it("超长指纹经截断逻辑后注入且总长受控", () => {
		const longProfile = "### Current Workspace Profile\n" + "- User overrides: " + "x".repeat(5000);
		const prompt = buildClassifierBasePrompt({ workspaceProfile: longProfile });
		assert.ok(prompt.length < 20000, "注入后总长应受控");
	});

	it("WORKSPACE_PROFILE_MAX_LENGTH 与截断标注契约存在", () => {
		assert.equal(typeof WORKSPACE_PROFILE_MAX_LENGTH, "number");
		assert.ok(WORKSPACE_PROFILE_MAX_LENGTH > 0 && WORKSPACE_PROFILE_MAX_LENGTH <= 4000);
	});
});
