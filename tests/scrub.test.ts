import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { scrubText, scrubJsonTree, SCRUB_FIELD_SCAN_CAP_BYTES } from "../extensions/scrub.ts";

test("scrub - API token（sk/key/token/ghp/gho/xoxb 前缀）命中并生成长度保持占位符", () => {
	const r1 = scrubText("export sk-abcdefghijklmnop1234 done");
	assert.equal(r1.text, "export [REDACTED:api-token:23] done");
	assert.equal(r1.hits.length, 1);
	assert.equal(r1.hits[0].class, "api-token");
	assert.equal(r1.hits[0].original, "sk-abcdefghijklmnop1234");
	assert.equal(r1.hits[0].placeholder, "[REDACTED:api-token:23]");
	assert.equal(r1.truncated, false);

	for (const token of [
		"key-0123456789abcdef",
		"token-0123456789abcdef",
		"ghp-0123456789abcdef",
		"gho-0123456789abcdef",
		"xoxb-0123456789abcdef",
	]) {
		const r = scrubText(`value=${token} tail`);
		assert.ok(r.text.includes(`[REDACTED:api-token:${token.length}]`), `漏报前缀变体: ${token}`);
	}
});

test("scrub - AWS Access Key（AKIA/ABIA/ACCA）命中", () => {
	const r = scrubText("AKIAIOSFODNN7EXAMPLE");
	assert.equal(r.text, "[REDACTED:aws-access-key:20]");
	assert.equal(r.hits.length, 1);
	assert.equal(r.hits[0].class, "aws-access-key");
});

test("scrub - JWT 紧凑格式命中", () => {
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
	const r = scrubText(`Authorization: Bearer ${jwt}`);
	assert.equal(r.text, `Authorization: Bearer [REDACTED:jwt:${jwt.length}]`);
	assert.equal(r.hits.length, 1);
	assert.equal(r.hits[0].class, "jwt");
});

test("scrub - URI 密码凭据仅替换密码段（协议头、用户名与主机保留）", () => {
	const r = scrubText("git clone https://alice:hunter2@example.com/repo.git");
	assert.equal(r.text, "git clone https://alice:[REDACTED:uri-credential:7]@example.com/repo.git");
	assert.equal(r.hits.length, 1);
	assert.equal(r.hits[0].original, "hunter2");
});

test("scrub - 私钥块整体替换（匹配至首个 END，标签残尾保留）", () => {
	const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34Gk\n-----END RSA PRIVATE KEY-----";
	const r = scrubText(`before\n${pem}\nafter`);
	const matchedLen = Buffer.byteLength("-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34Gk\n-----END", "utf8");
	assert.equal(r.text, `before\n[REDACTED:private-key:${matchedLen}] RSA PRIVATE KEY-----\nafter`);
	assert.equal(r.hits.length, 1);
	assert.equal(r.hits[0].class, "private-key");
});

test("scrub - .env 键值对：大小写混合键名命中且仅替换值段", () => {
	const r = scrubText(
		[
			"API_KEY=deadbeef00112233445566778899",
			"DbPassword=hunter2",
			"api_key=abc123",
			"auth_token = tt-9876543210",
			"NOT_RELEVANT=plain-value",
		].join("\n"),
	);
	assert.equal(
		r.text,
		[
			"API_KEY=[REDACTED:env-value:28]",
			"DbPassword=[REDACTED:env-value:7]",
			"api_key=[REDACTED:env-value:6]",
			"auth_token = [REDACTED:env-value:13]",
			"NOT_RELEVANT=plain-value",
		].join("\n"),
	);
	assert.equal(r.hits.length, 4);
	assert.ok(r.hits.every((h) => h.class === "env-value"));
});

test("scrub - .env 匹配不跨行（前导空行保留，防吞并相邻行结构）", () => {
	const r = scrubText("\n\nAPI_KEY=secret123\nTRAIL=tail");
	assert.equal(r.text, "\n\nAPI_KEY=[REDACTED:env-value:9]\nTRAIL=tail");
});

test("scrub - 幂等：对已脱敏文本重复执行不产生二次替换", () => {
	const samples = [
		"token-0123456789abcdef",
		"https://user:pass1234@host/path",
		"API_KEY=topsecret",
		"AKIAIOSFODNN7EXAMPLE",
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh",
		"-----BEGIN KEY-----\nMIIB\n-----END",
	];
	for (const s of samples) {
		const first = scrubText(s);
		assert.ok(first.hits.length > 0, `首轮应命中: ${s}`);
		const second = scrubText(first.text);
		assert.equal(second.text, first.text, `文本应幂等: ${s}`);
		assert.equal(second.hits.length, 0, `二轮应零命中: ${s}`);
	}
});

test("scrub - 普通文本零改动零命中", () => {
	const text = "git status && npm test\nno secrets here, just words like monkey-business";
	const r = scrubText(text);
	assert.equal(r.text, text);
	assert.equal(r.hits.length, 0);
	assert.equal(r.truncated, false);
});

test("scrub - 超限字段先按字节截断再扫描（含多字节边界保护）", () => {
	const long = "API_KEY=" + "z".repeat(60000);
	const r = scrubText(long);
	assert.equal(r.truncated, true);
	assert.equal(r.text, "API_KEY=[REDACTED:env-value:51192]");
	assert.ok(Buffer.byteLength(r.text, "utf8") <= SCRUB_FIELD_SCAN_CAP_BYTES);
	assert.equal(r.hits.length, 1);

	const multibyte = "密".repeat(SCRUB_FIELD_SCAN_CAP_BYTES);
	const r2 = scrubText(multibyte);
	assert.equal(r2.truncated, true);
	assert.ok(Buffer.byteLength(r2.text, "utf8") <= SCRUB_FIELD_SCAN_CAP_BYTES);
	assert.equal(Buffer.byteLength(r2.text, "utf8") % 3, 0);
	assert.ok(!r2.text.includes("\uFFFD"));
});

test("scrub - JSON 树递归脱敏：字符串值全字段覆盖，非字符串原样保留，入参不被修改", () => {
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh";
	const input = {
		toolName: "bash",
		rawArguments: {
			command: `curl -H 'Authorization: Bearer ${jwt}' https://x`,
			nested: [{ note: "API_KEY=leakme" }, "sk-abcdefghijklmnop1234"],
		},
		count: 3,
		ok: true,
		nothing: null,
	};
	const r = scrubJsonTree(input);
	assert.equal(r.hits.length, 3);
	assert.ok(r.value.rawArguments.command.includes(`[REDACTED:jwt:${jwt.length}]`));
	assert.equal(r.value.rawArguments.nested[0].note, "API_KEY=[REDACTED:env-value:6]");
	assert.equal(r.value.rawArguments.nested[1], "[REDACTED:api-token:23]");
	assert.equal(r.value.count, 3);
	assert.equal(r.value.ok, true);
	assert.equal(r.value.nothing, null);
	assert.equal(r.truncated, false);
	assert.equal(input.rawArguments.nested[1], "sk-abcdefghijklmnop1234");
});
