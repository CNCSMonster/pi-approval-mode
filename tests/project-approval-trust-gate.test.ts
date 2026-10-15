/**
 * 项目级审批策略与规则文件信任闸测试 (Project Approval Trust Gate Suite)
 *
 * 验证目标：
 * 1. 盲区拦截：当工作区仅包含 .pi/approval-* 时，阻断未经授权的静默信任；
 * 2. 真实继承与规范决策：与 ProjectTrustStore 对齐，支持父目录继承、单次会话信任与 Esc 取消 fail-closed；
 * 3. 命令行优先级覆盖：--no-approve 绝对否决与 --approve 显式授权；
 * 4. 无头与 RPC 最小权限安全降级；
 * 5. 跨 reload 与动态热添加文件的安全防护。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hasApprovalProjectResources,
	getActiveApprovalProjectResources,
	getProjectTrustParentPath,
	readGlobalDefaultProjectTrust,
	resolveEffectiveProjectTrust,
} from "../extensions/approval-trust.ts";
import {
	PermissionManager,
	getToolDefaultPermission,
} from "../extensions/permission-engine.ts";
import {
	setEffectiveProjectTrust,
} from "../extensions/approval-mode.ts";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

function setupTestEnv() {
	const testDir = mkdtempSync(join(tmpdir(), "pi-approval-trust-test-"));
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	const origArgv = [...process.argv];
	setEffectiveProjectTrust(false);

	const cleanup = () => {
		process.argv = origArgv;
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	};

	return { testDir, agentDir, projectDir, cleanup };
}

function createMockContext(projectDir: string, overrides: Partial<any> = {}) {
	const notified: Array<{ message: string; type: string }> = [];
	return {
		cwd: projectDir,
		hasUI: true,
		mode: "interactive",
		isProjectTrusted: () => true,
		ui: {
			select: async (_prompt: string, _options: string[]) => "Trust",
			notify: (message: string, type: string = "info") => {
				notified.push({ message, type });
			},
		},
		notified,
		...overrides,
	};
}

test("hasApprovalProjectResources 正确识别三种项目级审批资源", () => {
	const { projectDir, cleanup } = setupTestEnv();
	try {
		assert.equal(hasApprovalProjectResources(projectDir), false);

		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });

		// 1. approval-rules.json
		writeFileSync(join(piDir, "approval-rules.json"), "{}");
		assert.equal(hasApprovalProjectResources(projectDir), true);
		assert.deepEqual(getActiveApprovalProjectResources(projectDir), [".pi/approval-rules.json"]);

		// 2. approval-policy.md
		writeFileSync(join(piDir, "approval-policy.md"), "# Custom Policy");
		assert.ok(getActiveApprovalProjectResources(projectDir).includes(".pi/approval-policy.md"));

		// 3. approval-config.json
		writeFileSync(join(piDir, "approval-config.json"), "{}");
		assert.ok(getActiveApprovalProjectResources(projectDir).includes(".pi/approval-config.json"));
	} finally {
		cleanup();
	}
});

test("readGlobalDefaultProjectTrust 精确读取全局 agentDir/settings.json", () => {
	const { agentDir, cleanup } = setupTestEnv();
	try {
		assert.equal(readGlobalDefaultProjectTrust(agentDir), "ask");

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProjectTrust: "always" }),
		);
		assert.equal(readGlobalDefaultProjectTrust(agentDir), "always");

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProjectTrust: "never" }),
		);
		assert.equal(readGlobalDefaultProjectTrust(agentDir), "never");
	} finally {
		cleanup();
	}
});

test("无审批配置时，直接继承原生 isProjectTrusted 状态", async () => {
	const { projectDir, agentDir, cleanup } = setupTestEnv();
	try {
		const ctx = createMockContext(projectDir, { isProjectTrusted: () => true });
		const sessionTrustCache = new Map<string, boolean>();

		const trusted = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trusted, true);
	} finally {
		cleanup();
	}
});

test("原生明确否决 (isProjectTrusted === false) 时一票否决，插件决不反向放行", async () => {
	const { projectDir, agentDir, cleanup } = setupTestEnv();
	try {
		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "approval-rules.json"), "{}");

		const ctx = createMockContext(projectDir, { isProjectTrusted: () => false });
		const sessionTrustCache = new Map<string, boolean>();

		const trusted = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trusted, false);
	} finally {
		cleanup();
	}
});

test("无头环境 (hasUI === false) 遇到未受信任的审批配置时安全阻断 (Fail-Closed)", async () => {
	const { projectDir, agentDir, cleanup } = setupTestEnv();
	try {
		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "approval-policy.md"), "Allow all");

		const ctx = createMockContext(projectDir, { hasUI: false, isProjectTrusted: () => true });
		const sessionTrustCache = new Map<string, boolean>();

		const trusted = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trusted, false);
	} finally {
		cleanup();
	}
});

test("RPC 自动化模式遇到未受信任的审批配置时安全阻断，不挂死等待 UI", async () => {
	const { projectDir, agentDir, cleanup } = setupTestEnv();
	try {
		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "approval-policy.md"), "Allow all");

		const ctx = createMockContext(projectDir, { hasUI: true, mode: "rpc", isProjectTrusted: () => true });
		const sessionTrustCache = new Map<string, boolean>();

		const trusted = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trusted, false);
	} finally {
		cleanup();
	}
});

test("原生受控资源共存时直接复用原生信任，并透明披露激活的审批配置", async () => {
	const { projectDir, agentDir, cleanup } = setupTestEnv();
	try {
		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "settings.json"), "{}");
		writeFileSync(join(piDir, "approval-rules.json"), "{}");

		const ctx = createMockContext(projectDir, { isProjectTrusted: () => true });
		const sessionTrustCache = new Map<string, boolean>();

		const trusted = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trusted, true);
		assert.ok(ctx.notified.some((n: any) => n.message.includes(".pi/approval-rules.json")));
	} finally {
		cleanup();
	}
});

test("CLI --approve 显式授权压倒未登记的审批配置", async () => {
	const { projectDir, agentDir, cleanup } = setupTestEnv();
	try {
		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "approval-policy.md"), "Bypass policy");

		process.argv = ["node", "pi", "--approve"];
		const ctx = createMockContext(projectDir, { isProjectTrusted: () => true });
		const sessionTrustCache = new Map<string, boolean>();

		const trusted = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trusted, true);
	} finally {
		cleanup();
	}
});

test("交互模式用户选择 Trust 时，写入 ProjectTrustStore 并在后续免弹窗", async () => {
	const { projectDir, agentDir, cleanup } = setupTestEnv();
	try {
		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "approval-rules.json"), "{}");

		const trustStore = new ProjectTrustStore(agentDir);
		assert.equal(trustStore.get(projectDir), null);

		let selectPrompt = "";
		const ctx = createMockContext(projectDir, {
			ui: {
				select: async (prompt: string) => {
					selectPrompt = prompt;
					return "Trust";
				},
				notify: () => {},
			},
		});
		const sessionTrustCache = new Map<string, boolean>();

		const trusted = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trusted, true);
		assert.ok(selectPrompt.includes("Trust project approval policies and rules?"));
		assert.equal(trustStore.get(projectDir), true);

		// 第二次调用直接命中 trustStore，无需再弹窗
		let secondPromptFired = false;
		ctx.ui.select = async () => {
			secondPromptFired = true;
			return "Trust";
		};
		const trustedAgain = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trustedAgain, true);
		assert.equal(secondPromptFired, false);
	} finally {
		cleanup();
	}
});

test("交互模式用户选择 Trust parent folder 时，更新父目录且清除子目录冗余条目", async () => {
	const { projectDir, agentDir, cleanup } = setupTestEnv();
	try {
		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "approval-rules.json"), "{}");

		const trustStore = new ProjectTrustStore(agentDir);
		assert.equal(trustStore.get(projectDir), null);

		const parentPath = getProjectTrustParentPath(projectDir)!;
		const ctx = createMockContext(projectDir, {
			ui: {
				select: async () => `Trust parent folder (${parentPath})`,
				notify: () => {},
			},
		});
		const sessionTrustCache = new Map<string, boolean>();

		const trusted = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trusted, true);
		assert.equal(trustStore.get(parentPath), true);
		// 子目录自身被重置为 null，父目录继承生效
		const trustData = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf-8"));
		assert.equal(trustData[projectDir], undefined);
	} finally {
		cleanup();
	}
});

test("交互模式用户选择 Trust (this session only) 时，不写盘且跨 tool_call 缓存存活", async () => {
	const { projectDir, agentDir, cleanup } = setupTestEnv();
	try {
		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "approval-rules.json"), "{}");

		const trustStore = new ProjectTrustStore(agentDir);
		const ctx = createMockContext(projectDir, {
			ui: {
				select: async () => "Trust (this session only)",
				notify: () => {},
			},
		});
		const sessionTrustCache = new Map<string, boolean>();

		const trusted = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trusted, true);
		assert.equal(trustStore.get(projectDir), null); // 未持久化到 trust.json

		// 后续再次调用命中内存缓存
		let prompted = false;
		ctx.ui.select = async () => {
			prompted = true;
			return "Do not trust";
		};
		const trustedCached = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trustedCached, true);
		assert.equal(prompted, false);
	} finally {
		cleanup();
	}
});

test("交互模式用户 Esc 或取消时 Fail-Closed 返回 false 且不写盘", async () => {
	const { projectDir, agentDir, cleanup } = setupTestEnv();
	try {
		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "approval-rules.json"), "{}");

		const trustStore = new ProjectTrustStore(agentDir);
		const ctx = createMockContext(projectDir, {
			ui: {
				select: async () => undefined as any, // 模拟 Esc
				notify: () => {},
			},
		});
		const sessionTrustCache = new Map<string, boolean>();

		const trusted = await resolveEffectiveProjectTrust({
			cwd: projectDir,
			ctx,
			agentDir,
			sessionTrustCache,
		});
		assert.equal(trusted, false);
		assert.equal(trustStore.get(projectDir), null);
	} finally {
		cleanup();
	}
});

test("PermissionManager 显式 isTrusted=false 时安全阻断项目级规则", () => {
	const { projectDir, agentDir, cleanup } = setupTestEnv();
	try {
		const piDir = join(projectDir, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "approval-rules.json"),
			JSON.stringify({ allow: ["Bash(echo dangerous)"] }),
		);

		// 未受信任时，项目规则被标记为 blocked
		const pm = new PermissionManager(projectDir, agentDir, undefined, false);
		assert.equal(pm.getIsTrusted(), false);
		assert.equal(pm.isProjectRulesBlocked(), true);
		assert.equal(
			pm.evaluate({ toolName: "bash", input: { command: "echo dangerous" } }).decision,
			"default",
		);

		// 显式赋权后重载生效
		pm.setIsTrusted(true);
		assert.equal(pm.getIsTrusted(), true);
		assert.equal(pm.isProjectRulesBlocked(), false);
		assert.equal(
			pm.evaluate({ toolName: "bash", input: { command: "echo dangerous" } }).decision,
			"allow",
		);
	} finally {
		cleanup();
	}
});

test("getToolDefaultPermission 在未受信任工作区下不豁免祖先 skill 目录", () => {
	const { projectDir, cleanup } = setupTestEnv();
	try {
		const subDir = join(projectDir, "sub");
		mkdirSync(subDir, { recursive: true });
		const ancestorSkillPath = join(projectDir, ".agents", "skills", "helper.md");

		// 未受信环境下，读取祖先目录中的项目级 skill 时，isProjectTrusted 传 false 返回 ask
		const perm = getToolDefaultPermission("read", ancestorSkillPath, subDir, false);
		assert.equal(perm, "ask");

		// 受信工作区内，豁免祖先项目级 skill 返回 allow
		const permTrusted = getToolDefaultPermission("read", ancestorSkillPath, subDir, true);
		assert.equal(permTrusted, "allow");
	} finally {
		cleanup();
	}
});
