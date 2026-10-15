import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenizeShellCommand, analyzeShellCommand } from "../extensions/shell-analyzer.ts";
import { PermissionManager } from "../extensions/permission-engine.ts";
import { evaluateStrictReadOnlyCommand } from "../extensions/readonly-sandbox.ts";
import { isDangerousCommand, isDangerousRmCommand, evaluateFallbackAction } from "../extensions/heuristic-guard.ts";

describe("多行命令换行符作为分隔符的安全完备性", () => {
	describe("1. 词法状态机分词", () => {
		it("顶层无引号换行符 (LF 与 CRLF) 产生 op 标记", () => {
			const { tokens: tokensLf } = tokenizeShellCommand("git status\nrm -rf /tmp");
			const opsLf = tokensLf.filter((t) => t.type === "op");
			assert.equal(opsLf.length, 1);
			assert.equal(opsLf[0].value, "\n");

			const { tokens: tokensCrlf } = tokenizeShellCommand("git status\r\nrm -rf /tmp");
			const opsCrlf = tokensCrlf.filter((t) => t.type === "op");
			assert.equal(opsCrlf.length, 1);
			assert.equal(opsCrlf[0].value, "\n");
		});

		it("单引号与双引号内的换行符保持为字符串字面量，不产 op", () => {
			const { tokens: singleQuoted } = tokenizeShellCommand("echo 'line1\nline2'");
			assert.equal(singleQuoted.filter((t) => t.type === "op").length, 0);
			assert.equal(singleQuoted[1].value, "line1\nline2");

			const { tokens: doubleQuoted } = tokenizeShellCommand('echo "line1\nline2"');
			assert.equal(doubleQuoted.filter((t) => t.type === "op").length, 0);
			assert.equal(doubleQuoted[1].value, "line1\nline2");
		});

		it("连续换行与空白字符混合不崩溃，正确隔离命令", () => {
			const { tokens } = tokenizeShellCommand("ls -la \n\n  \r\n  pwd");
			const words = tokens.filter((t) => t.type === "word").map((t) => t.value);
			assert.deepEqual(words, ["ls", "-la", "pwd"]);
		});
	});

	describe("2. 静态 Shell 状态机分析", () => {
		it("多行混合高危命令被正确检出并拦截只读资格", () => {
			const resLf = analyzeShellCommand("git status\nrm -rf /tmp/victim");
			assert.equal(resLf.isReadOnly, false);
			assert.ok(resLf.detectedCommands.includes("git"));
			assert.ok(resLf.detectedCommands.includes("rm"));

			const resCrlf = analyzeShellCommand("ls\r\nrm -rf /tmp/victim");
			assert.equal(resCrlf.isReadOnly, false);
			assert.ok(resCrlf.detectedCommands.includes("ls"));
			assert.ok(resCrlf.detectedCommands.includes("rm"));
		});

		it("合法的全只读多行命令正常保持只读判定", () => {
			const res = analyzeShellCommand("git status\ngit diff\npwd");
			assert.equal(res.isReadOnly, true);
		});
	});

	describe("3. 规则引擎与权限状态机防绕过", () => {
		it("预设 Allow 规则无法通过换行符拼接破坏性命令逃逸", () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "pi-perm-test-"));
			try {
				const pm = new PermissionManager(tmpDir, tmpDir);
				pm.addRule("allow", "Bash(git status)", "session");

				const evalResult = pm.evaluate({
					toolName: "bash",
					input: { command: "git status\nrm -rf /tmp/victim" },
					cwd: process.cwd(),
				});
				assert.notEqual(evalResult.decision, "allow", "换行符拼接的高危命令绝不得被单行 allow 规则放行");
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("预设 Deny 规则在多行命令中任一行命中即触发拦截", () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "pi-perm-test-"));
			try {
				const pm = new PermissionManager(tmpDir, tmpDir);
				pm.addRule("deny", "Bash(rm *)", "session");

				const evalResult = pm.evaluate({
					toolName: "bash",
					input: { command: "ls -la\nrm -rf /tmp/victim" },
					cwd: process.cwd(),
				});
				assert.equal(evalResult.decision, "deny", "多行命令中的 rm 必须命中 deny 规则");
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("多行命令均在同一 Allow 规则覆盖范围内时放行", () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "pi-perm-test-"));
			try {
				const pm = new PermissionManager(tmpDir, tmpDir);
				pm.addRule("allow", "Bash(git *)", "session");

				const evalResult = pm.evaluate({
					toolName: "bash",
					input: { command: "git status\ngit diff" },
					cwd: process.cwd(),
				});
				assert.equal(evalResult.decision, "allow");
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("4. 只读沙盒与启发式兜底防线", () => {
		it("只读沙盒 Tier 2 拦截换行拼接的写入命令", () => {
			const check = evaluateStrictReadOnlyCommand("git status\nrm -rf /tmp/victim");
			assert.equal(check.isSafe, false);
		});

		it("启发式兜底 isDangerousRmCommand 识别换行后的破坏性 rm", () => {
			assert.equal(isDangerousRmCommand("ls -la\nrm -rf /"), true);
			assert.equal(isDangerousRmCommand("echo hi\r\nrm -rf ~"), true);
		});

		it("降级兜底 fallbackAction 与 isDangerousCommand 拦截换行高危命令", () => {
			const dangerous = isDangerousCommand("git status\nrm -rf /");
			assert.equal(dangerous.isDangerous, true);

			const fallback = evaluateFallbackAction("bash", { command: "git status\nrm -rf /" }, { cwd: process.cwd() });
			assert.equal(fallback.action, "require_approval");
		});
	});
});
