/**
 * tests/upstream-error-extractor.test.ts
 *
 * 上游错误结构化提取器单元测试
 */

import { test } from "node:test";
import assert from "node:assert";
import {
	extractUpstreamErrorInfo,
} from "../extensions/upstream-error-extractor.ts";

test("extractUpstreamErrorInfo - 403 锁区与 Forbidden 分支", () => {
	// 场景 1: 对象携带 status 403
	const err1 = { status: 403, message: "Country, region, or territory not supported" };
	const res1 = extractUpstreamErrorInfo(err1);
	assert.strictEqual(res1.category, "region_blocked");
	assert.strictEqual(res1.statusCode, 403);
	assert.strictEqual(res1.shortCode, "upstream_403(Region Blocked)");
	assert.match(res1.diagnosticHint, /地域锁区|网络代理分流/);

	// 场景 2: 文本匹配 403 与 Cloudflare 拦截
	const err2 = new Error("HTTP 403 Forbidden: Cloudflare Access Denied");
	const res2 = extractUpstreamErrorInfo(err2);
	assert.strictEqual(res2.category, "region_blocked");
	assert.strictEqual(res2.statusCode, 403);
	assert.strictEqual(res2.shortCode, "upstream_403(Region Blocked)");

	// 场景 3: 仅包含 region 关键词无显式 statusCode
	const err3 = "Access denied: region not supported";
	const res3 = extractUpstreamErrorInfo(err3);
	assert.strictEqual(res3.category, "region_blocked");
	assert.strictEqual(res3.statusCode, 403);
	assert.strictEqual(res3.shortCode, "upstream_403(Region Blocked)");
});

test("extractUpstreamErrorInfo - 401 认证失败分支", () => {
	// 场景 1: statusCode 401
	const err1 = { statusCode: 401, errorMessage: "Unauthorized: Invalid API Key" };
	const res1 = extractUpstreamErrorInfo(err1);
	assert.strictEqual(res1.category, "auth_failed");
	assert.strictEqual(res1.statusCode, 401);
	assert.strictEqual(res1.shortCode, "upstream_401(Auth Failed)");
	assert.match(res1.diagnosticHint, /API Key/);

	// 场景 2: 文本关键词匹配
	const err2 = "Error: Incorrect API key provided";
	const res2 = extractUpstreamErrorInfo(err2);
	assert.strictEqual(res2.category, "auth_failed");
	assert.strictEqual(res2.statusCode, 401);
	assert.strictEqual(res2.shortCode, "upstream_401(Auth Failed)");
});

test("extractUpstreamErrorInfo - 429 频控与配额限流分支", () => {
	const err1 = { response: { status: 429, data: { error: { message: "Rate limit exceeded" } } } };
	const res1 = extractUpstreamErrorInfo(err1);
	assert.strictEqual(res1.category, "rate_limited");
	assert.strictEqual(res1.statusCode, 429);
	assert.strictEqual(res1.shortCode, "upstream_429(Rate Limited)");
	assert.match(res1.diagnosticHint, /频率过高|配额/);

	const err2 = new Error("You exceeded your current quota, please check your plan");
	const res2 = extractUpstreamErrorInfo(err2);
	assert.strictEqual(res2.category, "rate_limited");
	assert.strictEqual(res2.shortCode, "upstream_429(Rate Limited)");
});

test("extractUpstreamErrorInfo - 网络故障与连接异常分支", () => {
	const err1 = new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:7890");
	const res1 = extractUpstreamErrorInfo(err1);
	assert.strictEqual(res1.category, "network_error");
	assert.strictEqual(res1.shortCode, "network_error");
	assert.match(res1.diagnosticHint, /代理服务/);

	const err2 = { message: "socket hang up while connecting to proxy" };
	const res2 = extractUpstreamErrorInfo(err2);
	assert.strictEqual(res2.category, "network_error");
});

test("extractUpstreamErrorInfo - 通用异常与边缘输入", () => {
	// 500 服务器内部错误
	const err1 = { status: 500, message: "Internal Server Error" };
	const res1 = extractUpstreamErrorInfo(err1);
	assert.strictEqual(res1.category, "generic_upstream");
	assert.strictEqual(res1.statusCode, 500);
	assert.strictEqual(res1.shortCode, "upstream_500");

	// 未知抛错
	const err2 = new Error("Some unexpected parsing failure");
	const res2 = extractUpstreamErrorInfo(err2);
	assert.strictEqual(res2.category, "generic_upstream");
	assert.strictEqual(res2.shortCode, "stage2_exception");

	// null / undefined
	const res3 = extractUpstreamErrorInfo(null);
	assert.strictEqual(res3.category, "generic_upstream");
	assert.strictEqual(res3.shortCode, "stage2_exception");
});
