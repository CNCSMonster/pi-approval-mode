import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	HIGH_RISK_PATTERNS,
	isProtectedPath,
	CLASSIFIER_BASE_PROMPT,
	SECURITY_POLICY_RULES,
} from "../extensions/heuristic-guard.ts";

describe("Claude Code 工业级安全规则吸收验证", () => {
	it("带租约 force 推送 (--force-with-lease) 应免除高危正则拦截，而裸 force (--force / -f) 必须拦截", () => {
		const safeCmd = "git push origin main --force-with-lease";
		const safeCmd2 = "git push --force-with-lease origin feature/login";
		const dangerousForce = "git push origin main --force";
		const dangerousF = "git push origin main -f";
		const dangerousMultipleF = "git push -f origin main";

		const isHighRisk = (cmd: string) => HIGH_RISK_PATTERNS.some((p) => p.test(cmd));

		assert.equal(isHighRisk(safeCmd), false, "git push --force-with-lease 不应被 HIGH_RISK_PATTERNS 拦截");
		assert.equal(isHighRisk(safeCmd2), false, "带分支的 --force-with-lease 不应被 HIGH_RISK_PATTERNS 拦截");

		assert.equal(isHighRisk(dangerousForce), true, "裸 --force 必须被 HIGH_RISK_PATTERNS 拦截");
		assert.equal(isHighRisk(dangerousF), true, "裸 -f 必须被 HIGH_RISK_PATTERNS 拦截");
		assert.equal(isHighRisk(dangerousMultipleF), true, "前置 -f 必须被 HIGH_RISK_PATTERNS 拦截");
	});

	it("扩充的现代特权凭据路径与集群路径必须被 isProtectedPath 拦截", () => {
		const sensitivePaths = [
			".pypirc",
			"/home/user/.pypirc",
			".git-credentials",
			"/root/.git-credentials",
			".config/gh/hosts.yml",
			"/home/user/.config/gh/hosts.yml",
			".config/glab-cli/config.yml",
			"k8s/deployment.yaml",
			"infra/helm/values.yaml",
			"cloud/iam/policy.json",
			"clusters/prod/rbac.yaml",
		];

		for (const p of sensitivePaths) {
			assert.equal(isProtectedPath(p), true, `路径 "${p}" 必须被 isProtectedPath 拦截`);
		}

		// 常规文件不应被误拦截
		assert.equal(isProtectedPath("src/index.ts"), false);
		assert.equal(isProtectedPath("package.json"), false);
		assert.equal(isProtectedPath("README.md"), false);
	});

	it("提示词中必须包含紧凑判词契约 (Reason ≤ 60 字符 / ≤ 15 词) 以及带租约 force 原则", () => {
		assert.ok(
			CLASSIFIER_BASE_PROMPT.includes("strictly under 15 words or 60 characters"),
			"Prompt 必须包含紧凑判词字符数与单词数约束",
		);
		assert.ok(
			CLASSIFIER_BASE_PROMPT.includes("git push --force-with-lease"),
			"Prompt 决策原则必须包含 force-with-lease 豁免说明",
		);
	});

	it("规则正负样本库声明完整且无断言漂移", () => {
		const gitRule = SECURITY_POLICY_RULES.find((r) => r.id === "git_read_operations");
		assert.ok(gitRule?.positiveSamples?.includes("git push origin main --force-with-lease"));

		const cleanRule = SECURITY_POLICY_RULES.find((r) => r.id === "destructive_workspace_clean");
		assert.ok(cleanRule?.negativeSamples?.includes("git push origin main --force"));
		assert.ok(cleanRule?.negativeSamples?.includes("git push origin feature -f"));
	});
});
