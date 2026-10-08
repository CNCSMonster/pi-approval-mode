import test from "node:test";
import assert from "node:assert/strict";
import {
	projectToolInput,
	PROJECTION_PREVIEW_LENGTH,
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

test("投影 - edit 只暴露 preview + 截断标记，不暴露全量内容", () => {
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

	const preview = out.edits_preview[0] as any;
	assert.equal(preview.old_preview.length, PROJECTION_PREVIEW_LENGTH);
	assert.equal(preview.new_preview.length, 300);
	assert.equal(preview.truncated, true);
	// 全量内容不得泄漏进投影结果
	assert.ok(!JSON.stringify(out).includes(longOld), "edit 全量 oldText 不应进入投影");
});

test("投影 - edit 数组仅投影前 N 项，其余计入 count", () => {
	const edits = Array.from({ length: 10 }, (_, i) => ({ oldText: `old${i}`, newText: `new${i}` }));
	const out = projectToolInput("edit", { path: "/p/a.ts", edits }, "/p");
	assert.equal(out.edits_count, 10);
	assert.equal(out.edits_preview.length, EDIT_PREVIEW_MAX);
});

test("投影 - write 只暴露 preview + byte_count + truncated", () => {
	const content = "z".repeat(PROJECTION_PREVIEW_LENGTH + 1);
	const out = projectToolInput("write", { path: "/p/out.txt", content }, "/p");
	assert.equal(out.byte_count, content.length);
	assert.equal(out.content_preview.length, PROJECTION_PREVIEW_LENGTH);
	assert.equal(out.content_truncated, true);
	assert.ok(!JSON.stringify(out).includes(content), "write 全量 content 不应进入投影");
});

test("投影 - 未知工具回退最小化投影 { toolName }", () => {
	const out = projectToolInput("task", { prompt: "do something" }, "/p");
	assert.deepEqual(out, { toolName: "task" });
});

test("投影 - read 只暴露 path，不暴露 offset/limit 等无关参数", () => {
	const out = projectToolInput("read", { path: "/etc/passwd", offset: 5, limit: 10 }, "/p");
	assert.deepEqual(out, { path: "/etc/passwd" });
});

test("投影 - grep / find / ls 读类工具投影与缺省边界", () => {
	const grepOut = projectToolInput("grep", { path: "/p/src", pattern: "export" }, "/p");
	assert.deepEqual(grepOut, { path: "/p/src", pattern: "export" });

	const findOut = projectToolInput("find", { path: "/p", pattern: "*.ts" }, "/p");
	assert.deepEqual(findOut, { path: "/p", pattern: "*.ts" });

	const lsOut = projectToolInput("ls", { path: "/p" }, "/p");
	assert.deepEqual(lsOut, { path: "/p" });

	// 缺省参数或非字符串类型回退空字符串兜底
	const defaultGrep = projectToolInput("grep", {}, "/p");
	assert.deepEqual(defaultGrep, { path: "", pattern: "" });

	const defaultLs = projectToolInput("ls", {}, "/p");
	assert.deepEqual(defaultLs, { path: "" });

	const defaultRead = projectToolInput("read", { path: 123 }, "/p");
	assert.deepEqual(defaultRead, { path: "" });

	const defaultBash = projectToolInput("bash", {}, "/p");
	assert.deepEqual(defaultBash, { command: "", cwd: "/p" });
});

test("投影 - edit 与 write 异常输入边界分支防御", () => {
	// edits 为非数组
	const invalidEdits = projectToolInput("edit", { edits: null }, "/p");
	assert.deepEqual(invalidEdits, { path: "", edits_count: 0, edits_preview: [] });

	// edit 项缺少 oldText / newText 或包含 null
	const partialEdits = projectToolInput("edit", {
		path: "/p/a.ts",
		edits: [null, {}, { oldText: "valid" }, { newText: "valid" }],
	}, "/p");
	assert.equal(partialEdits.edits_count, 4);
	assert.equal(partialEdits.edits_preview.length, 4);

	// write content 缺省或非字符串
	const defaultWrite = projectToolInput("write", {}, "/p");
	assert.deepEqual(defaultWrite, {
		path: "",
		byte_count: 0,
		content_preview: "",
		content_truncated: false,
	});
});
