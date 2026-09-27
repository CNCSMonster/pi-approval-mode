import test from "node:test";
import assert from "node:assert/strict";
import {
	parseDslRule,
	matchesCommandPattern,
	matchesPathPattern,
	PermissionManager,
} from "../extensions/permission-engine.ts";

test("DSL 解析器 - 正确解析各类 Tool(specifier) 规则", () => {
	const r1 = parseDslRule("Bash(git *)");
	assert.equal(r1.toolName, "Bash");
	assert.equal(r1.specifier, "git *");
	assert.equal(r1.specifierKind, "command");

	const r2 = parseDslRule("Read(/src/**)");
	assert.equal(r2.toolName, "Read");
	assert.equal(r2.specifier, "/src/**");
	assert.equal(r2.specifierKind, "path");

	const r3 = parseDslRule("Edit(.env*)");
	assert.equal(r3.toolName, "Edit");
	assert.equal(r3.specifier, ".env*");
	assert.equal(r3.specifierKind, "path");

	const r4 = parseDslRule("Bash");
	assert.equal(r4.toolName, "Bash");
	assert.equal(r4.specifier, undefined);
	assert.equal(r4.specifierKind, "command");
});

test("命令通配符匹配 - 单词边界与通配符", () => {
	// 1. 无通配符时，要求单词边界（不误匹配 gitk）
	assert.equal(matchesCommandPattern("git", "git"), true);
	assert.equal(matchesCommandPattern("git status", "git"), true);
	assert.equal(matchesCommandPattern("gitk", "git"), false);
	assert.equal(matchesCommandPattern("git-lfs pull", "git"), false);

	// 2. 带通配符模式
	assert.equal(matchesCommandPattern("git status", "git *"), true);
	assert.equal(matchesCommandPattern("git push origin main", "git push *"), true);
	assert.equal(matchesCommandPattern("npm test", "npm test*"), true);
	assert.equal(matchesCommandPattern("npm test --watch", "npm test*"), true);
	assert.equal(matchesCommandPattern("npm install", "npm test*"), false);

	// 3. 前导环境变量剥离
	assert.equal(matchesCommandPattern("NODE_ENV=production npm test", "npm test*"), true);
	assert.equal(matchesCommandPattern("A=1 B=2 git status", "git *"), true);
});

test("路径通配符匹配 - //, ~/, /, ./ 作用域支持", () => {
	const mockCwd = "/home/user/workspace/project";

	// 1. 项目相对路径 /src/**
	assert.equal(matchesPathPattern("src/index.ts", "/src/**", mockCwd), true);
	assert.equal(matchesPathPattern("src/utils/math.ts", "/src/**", mockCwd), true);
	assert.equal(matchesPathPattern("docs/readme.md", "/src/**", mockCwd), false);

	// 2. 点文件通配 .env*
	assert.equal(matchesPathPattern(".env", ".env*", mockCwd), true);
	assert.equal(matchesPathPattern(".env.local", ".env*", mockCwd), true);
	assert.equal(matchesPathPattern(".env.production", ".env*", mockCwd), true);
	assert.equal(matchesPathPattern("src/index.ts", ".env*", mockCwd), false);

	// 3. 绝对文件系统根 //etc/**
	assert.equal(matchesPathPattern("/etc/passwd", "//etc/**", mockCwd), true);
	assert.equal(matchesPathPattern("/etc/shadow", "//etc/**", mockCwd), true);
	assert.equal(matchesPathPattern("/home/user/test", "//etc/**", mockCwd), false);
});

test("PermissionManager - Deny-First 状态机与决策优先级", () => {
	const pm = new PermissionManager("/mock/cwd");

	// 添加冲突规则：同时存在 Deny, Ask, Allow
	pm.addRule("allow", "Bash(git *)", "session");
	pm.addRule("deny", "Bash(git push *--force*)", "session");
	pm.addRule("ask", "Bash(git push *)", "session");

	// 1. git status: 命中 allow
	const r1 = pm.evaluate({ cwd: "/mock/cwd", toolName: "bash", input: { command: "git status" } });
	assert.equal(r1.decision, "allow");

	// 2. git push origin main: 命中 ask (Ask > Allow)
	const r2 = pm.evaluate({
		cwd: "/mock/cwd",
		toolName: "bash",
		input: { command: "git push origin main" },
	});
	assert.equal(r2.decision, "ask");

	// 3. git push origin main --force: 命中 deny (Deny > Ask > Allow)
	const r3 = pm.evaluate({
		cwd: "/mock/cwd",
		toolName: "bash",
		input: { command: "git push origin main --force" },
	});
	assert.equal(r3.decision, "deny");
	assert.equal(r3.matchedRule, "Bash(git push *--force*)");

	// 4. 未命中规则: 返回 default
	const r4 = pm.evaluate({
		cwd: "/mock/cwd",
		toolName: "bash",
		input: { command: "docker run -it alpine" },
	});
	assert.equal(r4.decision, "default");
});

test("PermissionManager - 宏元分类覆盖 (Read, Edit, Bash)", () => {
	const pm = new PermissionManager("/mock/cwd");

	pm.addRule("deny", "Read(.env*)", "session");
	pm.addRule("allow", "Edit(/src/**)", "session");

	// Read 宏覆盖 read, grep, glob
	const r1 = pm.evaluate({ cwd: "/mock/cwd", toolName: "read", input: { path: ".env" } });
	assert.equal(r1.decision, "deny");

	const r2 = pm.evaluate({ cwd: "/mock/cwd", toolName: "read_file", input: { path: ".env.local" } });
	assert.equal(r2.decision, "deny");

	// Edit 宏覆盖 edit, write
	const r3 = pm.evaluate({
		cwd: "/mock/cwd",
		toolName: "edit",
		input: { path: "src/components/Button.tsx" },
	});
	assert.equal(r3.decision, "allow");

	const r4 = pm.evaluate({
		cwd: "/mock/cwd",
		toolName: "write",
		input: { path: "src/utils/helper.ts" },
	});
	assert.equal(r4.decision, "allow");
});
