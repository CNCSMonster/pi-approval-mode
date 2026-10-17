import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PermissionManager,
} from "../extensions/permission-engine.ts";

test("符号链接击穿防御 - Read 路径规则对工作区外逃逸符号链接不得放行", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-symlink-test-"));
	const workspaceDir = join(baseDir, "workspace");
	const outsideDir = join(baseDir, "outside");
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(outsideDir, { recursive: true });

	try {
		// 在工作区外建一个敏感文件
		const secretFile = join(outsideDir, "secret.txt");
		writeFileSync(secretFile, "SUPER_SECRET_KEY=123456\n");

		// 在工作区内建 src/ 目录，以及指向工作区外的符号链接 src/outside-link -> outsideDir
		const srcDir = join(workspaceDir, "src");
		mkdirSync(srcDir, { recursive: true });
		const symlinkDir = join(srcDir, "outside-link");
		symlinkSync(outsideDir, symlinkDir, "dir");

		const targetToRead = join(symlinkDir, "secret.txt");

		// 用户配置了工作区相对路径允许规则: Read(/src/**)
		const pm = new PermissionManager(workspaceDir, workspaceDir);
		pm.addRule("allow", "Read(/src/**)", "project");

		// 端到端评估 read 工具
		const result = pm.evaluate({
			toolName: "read",
			input: { file_path: targetToRead },
			cwd: workspaceDir,
		});

		// 核心安全断言: 符号链接真实目标逃逸出工作区，绝不得命中 Read(/src/**) 的 allow 放行！
		assert.notEqual(
			result.decision,
			"allow",
			"工作区内符号链接逃逸到区外读取敏感文件时，绝不能被 Read(/src/**) 规则静默 allow",
		);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("符号链接击穿防御 - Edit 路径规则对工作区外逃逸符号链接不得放行", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-symlink-edit-test-"));
	const workspaceDir = join(baseDir, "workspace");
	const outsideDir = join(baseDir, "outside");
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(outsideDir, { recursive: true });

	try {
		const targetFile = join(outsideDir, "target.ts");
		writeFileSync(targetFile, "console.log('original');\n");

		const srcDir = join(workspaceDir, "src");
		mkdirSync(srcDir, { recursive: true });
		const symlinkFile = join(srcDir, "link-to-target.ts");
		symlinkSync(targetFile, symlinkFile, "file");

		const pm = new PermissionManager(workspaceDir, workspaceDir);
		pm.addRule("allow", "Edit(/src/**)", "project");

		const result = pm.evaluate({
			toolName: "edit",
			input: { file_path: symlinkFile },
			cwd: workspaceDir,
		});

		assert.notEqual(
			result.decision,
			"allow",
			"工作区内符号链接逃逸到区外修改文件时，绝不能被 Edit(/src/**) 规则静默 allow",
		);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});

test("符号链接解析失败 - 断链或不存在路径保守降级，绝不词法放行", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-broken-link-test-"));
	const workspaceDir = join(baseDir, "workspace");
	mkdirSync(workspaceDir, { recursive: true });

	try {
		const srcDir = join(workspaceDir, "src");
		mkdirSync(srcDir, { recursive: true });
		// 构造一个指向不存在文件的死链
		const brokenLink = join(srcDir, "broken-link.txt");
		symlinkSync(join(baseDir, "non-existent-target.txt"), brokenLink, "file");

		const pm = new PermissionManager(workspaceDir, workspaceDir);
		pm.addRule("allow", "Read(/src/**)", "project");

		const result = pm.evaluate({
			toolName: "read",
			input: { file_path: brokenLink },
			cwd: workspaceDir,
		});

		// 死链无法 realpath，保守处理：不得放行
		assert.notEqual(
			result.decision,
			"allow",
			"断链路径无法做 realpath 解析时，必须保守降级，不得词法放行",
		);
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
});
