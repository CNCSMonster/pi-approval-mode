import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isBubblewrapAvailable,
	resetBwrapCacheForTesting,
	isSeatbeltAvailable,
	detectSandboxCapability,
	evaluateStrictReadOnlyCommand,
	wrapReadOnlyBashCommand,
	formatReadOnlyFileError,
	formatReadOnlyCommandBlocked,
	READONLY_MODE_SYSTEM_REMINDER,
	type SandboxCapability,
} from "../extensions/readonly-sandbox.ts";

test("readonly-sandbox - isBubblewrapAvailable 与缓存及平台隔离", () => {
	// 保存初始状态
	resetBwrapCacheForTesting(undefined);

	// 模拟非 Linux 环境
	if (process.platform !== "linux") {
		assert.equal(isBubblewrapAvailable(), false);
	}

	// 测试桩手动注入
	resetBwrapCacheForTesting(true);
	assert.equal(isBubblewrapAvailable(), true);

	resetBwrapCacheForTesting(false);
	assert.equal(isBubblewrapAvailable(), false);

	// 恢复重置
	resetBwrapCacheForTesting(undefined);
});

test("readonly-sandbox - isSeatbeltAvailable 平台隔离", () => {
	if (process.platform !== "darwin") {
		assert.equal(isSeatbeltAvailable(), false);
	}
});

test("readonly-sandbox - detectSandboxCapability 跨平台分层与通知", () => {
	// 1. macOS 平台 -> Tier 1 Seatbelt
	const macCap = detectSandboxCapability("darwin");
	assert.equal(macCap.tier, "tier1_seatbelt");
	assert.equal(macCap.isSandboxSupported, true);

	// 2. Linux 具备 bwrap -> Tier 1 bwrap
	resetBwrapCacheForTesting(true);
	const linuxWithBwrap = detectSandboxCapability("linux");
	assert.equal(linuxWithBwrap.tier, "tier1_bwrap");
	assert.equal(linuxWithBwrap.isSandboxSupported, true);

	// 3. Linux 缺失 bwrap -> Tier 2 白名单降级与 apt 安装建议
	resetBwrapCacheForTesting(false);
	const linuxNoBwrap = detectSandboxCapability("linux");
	assert.equal(linuxNoBwrap.tier, "tier2_allowlist");
	assert.equal(linuxNoBwrap.isSandboxSupported, false);
	assert.match(linuxNoBwrap.advisoryNotice || "", /bubblewrap/);

	// 4. Windows 平台 -> Tier 2 白名单降级
	const winCap = detectSandboxCapability("win32");
	assert.equal(winCap.tier, "tier2_allowlist");
	assert.equal(winCap.isSandboxSupported, false);
	assert.match(winCap.advisoryNotice || "", /Windows/);

	// 5. 其他平台 (freebsd 等)
	const otherCap = detectSandboxCapability("freebsd");
	assert.equal(otherCap.tier, "tier2_allowlist");
	assert.equal(otherCap.isSandboxSupported, false);

	// 恢复重置
	resetBwrapCacheForTesting(undefined);
});

test("readonly-sandbox - wrapReadOnlyBashCommand 沙盒包装命令与单引号转义", () => {
	const rawCmd = "echo 'hello world' && ls";

	// macOS Tier 1
	const macCap: SandboxCapability = { platform: "darwin", tier: "tier1_seatbelt", isSandboxSupported: true };
	const macWrapped = wrapReadOnlyBashCommand(rawCmd, macCap);
	assert.equal(macWrapped.sandboxed, true);
	assert.equal(macWrapped.tier, "tier1_seatbelt");
	assert.match(macWrapped.command, /^sandbox-exec -p '\(version 1\)\(allow default\)\(deny file-write\*\)'/);
	assert.ok(macWrapped.command.includes("'\\''hello world'\\''"));

	// Linux Tier 1 bwrap
	const bwrapCap: SandboxCapability = { platform: "linux", tier: "tier1_bwrap", isSandboxSupported: true };
	const linuxWrapped = wrapReadOnlyBashCommand(rawCmd, bwrapCap);
	assert.equal(linuxWrapped.sandboxed, true);
	assert.equal(linuxWrapped.tier, "tier1_bwrap");
	assert.match(linuxWrapped.command, /^bwrap --ro-bind \/ \/ --dev \/dev --proc \/proc/);

	// Tier 2 降级模式不包装原生命令
	const tier2Cap: SandboxCapability = { platform: "win32", tier: "tier2_allowlist", isSandboxSupported: false };
	const tier2Wrapped = wrapReadOnlyBashCommand(rawCmd, tier2Cap);
	assert.equal(tier2Wrapped.sandboxed, false);
	assert.equal(tier2Wrapped.command, rawCmd);
});

test("readonly-sandbox - evaluateStrictReadOnlyCommand 白名单校验与重定向拦截", () => {
	// 空命令放行
	assert.equal(evaluateStrictReadOnlyCommand("   ").isSafe, true);

	// 常见只读工具放行
	const safeCommands = [
		"git",
		"cargo check",
		"cargo test",
		"cargo clippy",
		"npm test",
		"npm run test",
		"npm -v",
		"npm --version",
		"ls -la",
		"cat README.md",
		"head -n 20 main.ts",
		"tail -f log.txt",
		"grep 'export' package.json",
		"rg 'TODO' .",
		"find . -name '*.ts'",
		"pwd",
		"which node",
		"env",
		"printenv PATH",
		"echo 'read only check'",
		"wc -l file.txt",
		"diff a.txt b.txt",
		"git status",
		"git diff HEAD~1",
		"git log -n 5",
		"git show commit_id",
		"git branch -a",
	];
	for (const cmd of safeCommands) {
		const res = evaluateStrictReadOnlyCommand(cmd);
		assert.equal(res.isSafe, true, `命令 "${cmd}" 应该被允许`);
	}

	// 复合只读命令放行
	assert.equal(evaluateStrictReadOnlyCommand("pwd && ls -la && git status").isSafe, true);
	assert.equal(evaluateStrictReadOnlyCommand("git branch; git log").isSafe, true);
	assert.equal(evaluateStrictReadOnlyCommand("ls &&   && pwd").isSafe, true);

	// cargo 和 npm 缺省或危险子命令拦截
	assert.equal(evaluateStrictReadOnlyCommand("cargo").isSafe, false);
	assert.equal(evaluateStrictReadOnlyCommand("npm").isSafe, false);

	// 拦截写重定向 (>, >>)
	assert.equal(evaluateStrictReadOnlyCommand("echo 'hack' > file.txt").isSafe, false);
	assert.equal(evaluateStrictReadOnlyCommand("cat a >> b").isSafe, false);
	assert.equal(evaluateStrictReadOnlyCommand("ls 2> err.txt").isSafe, false);
	assert.equal(evaluateStrictReadOnlyCommand("ls &> all.txt").isSafe, false);

	// 拦截非只读命令
	const dangerousCommands = [
		"rm -rf node_modules",
		"touch newfile.txt",
		"mkdir src/newdir",
		"gcc main.c",
		"make install",
		"kill 1234",
		"chmod 777 script.sh",
		"git commit -m 'feat'",
		"git push origin main",
		"git stash drop",
		"git stash pop",
		"cargo build",
		"npm install",
		"npm publish",
	];
	for (const cmd of dangerousCommands) {
		const res = evaluateStrictReadOnlyCommand(cmd);
		assert.equal(res.isSafe, false, `危险命令 "${cmd}" 应该被拦截`);
	}

	// git stash list 和 git stash show 放行
	assert.equal(evaluateStrictReadOnlyCommand("git stash list").isSafe, true);
	assert.equal(evaluateStrictReadOnlyCommand("git stash show").isSafe, true);
});

test("readonly-sandbox - formatReadOnlyFileError 与 formatReadOnlyCommandBlocked 契约", () => {
	const fileErr = formatReadOnlyFileError("/tmp/test.ts");
	assert.match(fileErr, /EROFS: read-only file system/);
	assert.match(fileErr, /\/tmp\/test\.ts/);
	assert.match(fileErr, /Read-Only mode/);

	const cmdErr = formatReadOnlyCommandBlocked("rm test", "forbidden");
	assert.match(cmdErr, /\[Read-Only Mode\]/);
	assert.match(cmdErr, /rm test/);
	assert.match(cmdErr, /forbidden/);

	assert.match(READONLY_MODE_SYSTEM_REMINDER, /<system-reminder>/);
	assert.match(READONLY_MODE_SYSTEM_REMINDER, /Read-Only/);
});
