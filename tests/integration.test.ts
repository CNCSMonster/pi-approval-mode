import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeShellCommand } from "../extensions/shell-analyzer.ts";
import { PermissionManager } from "../extensions/permission-engine.ts";

test("端到端集成 - 预设 Deny 规则优先于 Shell 只读快路径", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-perm-test-"));
	try {
		const pm = new PermissionManager(tmpDir);

		// 即使 ls 是只读命令，如果配置了 Deny 规则，也必须坚决阻断
		pm.addRule("deny", "Bash(ls /secret*)", "session");

		const r1 = pm.evaluate({
			cwd: tmpDir,
			toolName: "bash",
			input: { command: "ls /secret/keys" },
		});
		assert.equal(r1.decision, "deny");
		assert.equal(r1.matchedRule, "Bash(ls /secret*)");

		// 普通 ls 放行
		const r2 = pm.evaluate({
			cwd: tmpDir,
			toolName: "bash",
			input: { command: "ls -la" },
		});
		assert.equal(r2.decision, "default");
		// 随后由 Shell 分析器判定为只读
		const shellAnalysis = analyzeShellCommand("ls -la");
		assert.equal(shellAnalysis.isReadOnly, true);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("端到端集成 - 重定向与复合注入在 Layer 2 被彻底剥夺只读资格", () => {
	const attacks = [
		{ cmd: "cat README.md > hacked.txt", reasonSubstring: "输出重定向" },
		{ cmd: "echo 123 >> .bashrc", reasonSubstring: "输出重定向" },
		{ cmd: "ls && rm -rf /", reasonSubstring: "未在只读白名单中" },
		{ cmd: "pwd; git push origin main", reasonSubstring: "git 子命令" },
		{ cmd: "find . -name '*.log' -exec rm {} +", reasonSubstring: "危险执行参数" },
		{ cmd: "cat /etc/passwd | bash", reasonSubstring: "不安全过滤器" },
	];

	for (const { cmd, reasonSubstring } of attacks) {
		const res = analyzeShellCommand(cmd);
		assert.equal(res.isReadOnly, false, `漏洞穿透: 命令 "${cmd}" 被误判为只读！`);
		assert.ok(
			res.reason?.includes(reasonSubstring),
			`原因说明 "${res.reason}" 未包含预期 "${reasonSubstring}"`,
		);
	}
});

test("端到端集成 - 三态规则覆盖敏感文件与提权防范", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "pi-perm-test-"));
	try {
		const pm = new PermissionManager(tmpDir);

		// 封禁读取任何 .env 与密钥
		pm.addRule("deny", "Read(.env*)", "project");
		pm.addRule("deny", "Read(~/.ssh/**)", "session");

		// 强制要求人工审核写入 package.json
		pm.addRule("ask", "Edit(/package.json)", "project");

		// 1. 读取 .env 必须被 Deny
		const envCheck = pm.evaluate({
			cwd: tmpDir,
			toolName: "read_file",
			input: { path: ".env" },
		});
		assert.equal(envCheck.decision, "deny");

		// 2. 修改 package.json 必须命中 Ask
		const pkgCheck = pm.evaluate({
			cwd: tmpDir,
			toolName: "edit",
			input: { path: "package.json" },
		});
		assert.equal(pkgCheck.decision, "ask");

		// 3. 修改 src/index.ts 未命中规则，进入 default 漏斗
		const srcCheck = pm.evaluate({
			cwd: tmpDir,
			toolName: "edit",
			input: { path: "src/index.ts" },
		});
		assert.equal(srcCheck.decision, "default");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
