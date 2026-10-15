import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	projectToolInput,
	resolvePathForProjection,
	PROJECTION_PREVIEW_LENGTH,
	PROJECTION_HEAD_LENGTH,
	PROJECTION_TAIL_LENGTH,
	EDIT_PREVIEW_MAX,
} from "../extensions/classifier-projection.ts";

test("投影 - bash 只暴露 command + cwd", () => {
	const out = projectToolInput(
		"bash",
		{ command: "git push origin main --force", timeout: 30000 },
		"/home/user/project",
	);
	assert.deepEqual(out, { command: "git push origin main --force", cwd: "/home/user/project" });
});

test("投影 - edit 暴露 preview + 截断标记与全局 content_truncated", () => {
	const longOld = "x".repeat(PROJECTION_PREVIEW_LENGTH + 100);
	const longNew = "y".repeat(500);
	const out = projectToolInput(
		"edit",
		{ path: "/p/.env", edits: [{ oldText: longOld, newText: longNew }] },
		"/p",
	);

	assert.equal(out.path, "/p/.env");
	assert.equal(out.edits_count, 1);
	assert.equal(out.edits_preview.length, 1);
	assert.equal(out.content_truncated, true);

	const preview = out.edits_preview[0] as any;
	assert.equal(preview.old_preview.length, PROJECTION_PREVIEW_LENGTH);
	assert.equal(preview.new_preview.length, 500);
	assert.equal(preview.truncated, true);
	// 全量内容不得泄漏进投影结果
	assert.ok(!JSON.stringify(out).includes(longOld), "edit 全量 oldText 不应进入投影");
});

test("投影 - edit 数组仅投影前 N 项，其余计入 count 且标记全局截断", () => {
	const edits = Array.from({ length: 15 }, (_, i) => ({ oldText: `old${i}`, newText: `new${i}` }));
	const out = projectToolInput("edit", { path: "/p/a.ts", edits }, "/p");
	assert.equal(out.edits_count, 15);
	assert.equal(out.edits_preview.length, EDIT_PREVIEW_MAX);
	assert.equal(out.content_truncated, true);
});

test("投影 - write 未超限时暴露 content_preview 与 byte_count，未截断", () => {
	const content = "hello world";
	const out = projectToolInput("write", { path: "/p/out.txt", content }, "/p");
	assert.equal(out.byte_count, content.length);
	assert.equal(out.content_preview, content);
	assert.equal(out.content_truncated, false);
});

test("投影 - write 超过预算时暴露 head/tail 采样与 byte_count，标记截断", () => {
	const content = "head-" + "z".repeat(PROJECTION_PREVIEW_LENGTH + 100) + "-tail";
	const out = projectToolInput("write", { path: "/p/out.txt", content }, "/p");
	assert.equal(out.byte_count, content.length);
	assert.equal(out.preview_head.length, PROJECTION_HEAD_LENGTH);
	assert.equal(out.preview_tail.length, PROJECTION_TAIL_LENGTH);
	assert.equal(out.content_truncated, true);
	assert.ok(!JSON.stringify(out).includes(content), "write 全量 content 不应进入投影");
});

test("投影 - 未知工具回退最小化投影附带 unknown_tool 标记", () => {
	const out = projectToolInput("task", { prompt: "do something" }, "/p");
	assert.deepEqual(out, { toolName: "task", unknown_tool: true });
});

test("投影 - read 暴露路径及其真实解析目标", () => {
	const out = projectToolInput("read", { path: "/etc/passwd", offset: 5, limit: 10 }, "/p");
	assert.equal(out.path, "/etc/passwd");
	assert.equal(out.resolved_path, "/etc/passwd");
});

test("投影 - grep / find / ls 读类工具投影与缺省边界", () => {
	const grepOut = projectToolInput("grep", { path: "/p/src", pattern: "export" }, "/p");
	assert.equal(grepOut.path, "/p/src");
	assert.equal(grepOut.pattern, "export");

	const findOut = projectToolInput("find", { path: "/p", pattern: "*.ts" }, "/p");
	assert.equal(findOut.path, "/p");
	assert.equal(findOut.pattern, "*.ts");

	const lsOut = projectToolInput("ls", { path: "/p" }, "/p");
	assert.equal(lsOut.path, "/p");

	// 缺省参数或非字符串类型回退空字符串兜底
	const defaultGrep = projectToolInput("grep", {}, "/p");
	assert.equal(defaultGrep.path, "");
	assert.equal(defaultGrep.pattern, "");

	const defaultLs = projectToolInput("ls", {}, "/p");
	assert.equal(defaultLs.path, "");

	const defaultRead = projectToolInput("read", { path: 123 }, "/p");
	assert.equal(defaultRead.path, "");

	const defaultBash = projectToolInput("bash", {}, "/p");
	assert.deepEqual(defaultBash, { command: "", cwd: "/p" });
});

test("投影 - 路径真实解析（正常文件、祖先存在新文件、悬垂符号链接）", () => {
	const testDir = join(tmpdir(), `pi-test-proj-path-${Date.now()}`);
	mkdirSync(testDir, { recursive: true });

	try {
		// 1. 真实已存在文件
		const realFile = join(testDir, "real.txt");
		writeFileSync(realFile, "ok");
		const res1 = resolvePathForProjection("real.txt", testDir);
		assert.equal(res1.resolved_path, realFile);
		assert.equal(res1.resolved_from, "direct");

		// 2. 尚不存在的新建文件（父目录存在）
		const res2 = resolvePathForProjection("subdir/new.txt", testDir);
		assert.ok(res2.resolved_path?.endsWith("subdir/new.txt"));
		assert.equal(res2.resolved_from, "ancestor");

		// 3. 悬垂符号链接（链接本身存在但指向不存在的目标）
		const danglingLink = join(testDir, "dangling.lnk");
		symlinkSync("/non/existent/target/path", danglingLink);
		const res3 = resolvePathForProjection("dangling.lnk", testDir);
		assert.equal(res3.dangling_symlink, true);
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
});

test("投影 - edit 与 write 异常输入边界分支防御", () => {
	// edits 为非数组
	const invalidEdits = projectToolInput("edit", { edits: null }, "/p");
	assert.equal(invalidEdits.path, "");
	assert.equal(invalidEdits.edits_count, 0);
	assert.deepEqual(invalidEdits.edits_preview, []);
	assert.equal(invalidEdits.content_truncated, false);

	// edit 项缺少 oldText / newText 或包含 null
	const partialEdits = projectToolInput("edit", {
		path: "/p/a.ts",
		edits: [null, {}, { oldText: "valid" }, { newText: "valid" }],
	}, "/p");
	assert.equal(partialEdits.edits_count, 4);
	assert.equal(partialEdits.edits_preview.length, 4);

	// write content 缺省或非字符串
	const defaultWrite = projectToolInput("write", {}, "/p");
	assert.equal(defaultWrite.path, "");
	assert.equal(defaultWrite.byte_count, 0);
	assert.equal(defaultWrite.content_preview, "");
	assert.equal(defaultWrite.content_truncated, false);
});
