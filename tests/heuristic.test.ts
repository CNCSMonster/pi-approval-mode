import test from "node:test";
import assert from "node:assert/strict";
import {
	isDangerousCommand,
	isDangerousRmCommand,
	fallbackHeuristicCheck,
} from "../extensions/heuristic-guard.ts";

test("启发式兜底 - /dev/null 重定向不应被误判为高危破坏", () => {
	const benignRedirections = [
		"npm test 2>/dev/null",
		"grep pattern file.txt >/dev/null",
		"curl -s https://example.com > /dev/null 2>&1",
		"python3 -c 'print(1)' 2> /dev/null",
	];

	for (const cmd of benignRedirections) {
		const res = isDangerousCommand(cmd);
		assert.equal(res.isDangerous, false, `误判无害重定向命令: ${cmd}`);
		const check = fallbackHeuristicCheck("bash", { command: cmd });
		assert.equal(check.shouldBlock, false);
	}

	// 真正的裸设备破坏写入必须被阻断
	const dangerousDevWrites = [
		"echo dangerous > /dev/sda",
		"cat image.raw > /dev/nvme0n1",
		"dd if=/dev/zero of=/dev/sda1",
	];

	for (const cmd of dangerousDevWrites) {
		const res = isDangerousCommand(cmd);
		assert.equal(res.isDangerous, true, `漏报设备写入破坏: ${cmd}`);
		const check = fallbackHeuristicCheck("bash", { command: cmd });
		assert.equal(check.shouldBlock, true);
	}
});

test("启发式兜底 - 常见构建与缓存产物目录允许 rm -r 递归清理", () => {
	const safeRmCommands = [
		"rm -rf node_modules",
		"rm -rf dist",
		"rm -rf build",
		"rm -rf coverage",
		"rm -rf .next",
		"rm -rf .cache",
		"rm -rf tmp",
		"rm -rf out",
		"rm -rf target",
		"rm -rf .turbo",
		"rm -fr node_modules",
		"rm -r -f dist",
		"rm -f -r build",
		"rm --recursive -f coverage",
		"rm -rf ./dist",
		"rm -rf dist/",
		"rm -rf ./node_modules/",
		"rm -rf dist build tmp",
		"npm run clean && rm -rf dist",
	];

	for (const cmd of safeRmCommands) {
		const res = isDangerousCommand(cmd);
		assert.equal(res.isDangerous, false, `误报安全的构建清理: ${cmd}`);
		assert.equal(isDangerousRmCommand(cmd), false, `isDangerousRmCommand 误报: ${cmd}`);
		const check = fallbackHeuristicCheck("bash", { command: cmd });
		assert.equal(check.shouldBlock, false);
	}
});

test("启发式兜底 - 高危 rm 破坏性指令精准拦截", () => {
	const dangerousRmCommands = [
		"rm -rf /",
		"rm -rf ~",
		"rm -rf .",
		"rm -rf ..",
		"rm -rf *",
		"rm -rf src",
		"rm -rf /etc",
		"rm -rf ../dist",
		"rm -rf ~/dist",
		"rm -rf dist src",
		"rm -fr /",
		"rm -r -f ~",
		"rm --recursive /",
		"rm -f /etc/passwd",
		"rm -f ~/.bashrc",
		"rm -f .env",
		"rm -f .git/config",
		"rm -f AGENTS.md",
		"make && rm -rf /",
	];

	for (const cmd of dangerousRmCommands) {
		const res = isDangerousCommand(cmd);
		assert.equal(res.isDangerous, true, `漏报危险删除命令: ${cmd}`);
		assert.equal(isDangerousRmCommand(cmd), true, `isDangerousRmCommand 漏报: ${cmd}`);
		const check = fallbackHeuristicCheck("bash", { command: cmd });
		assert.equal(check.shouldBlock, true);
	}
});

test("启发式兜底 - git rm 不被误判为危险的系统 rm 命令", () => {
	const gitRmCmd = "git rm -r --cached .";
	const res = isDangerousCommand(gitRmCmd);
	assert.equal(res.isDangerous, false, `git rm 被误判为 rm: ${gitRmCmd}`);
	assert.equal(isDangerousRmCommand(gitRmCmd), false);
	const check = fallbackHeuristicCheck("bash", { command: gitRmCmd });
	assert.equal(check.shouldBlock, false);
});
