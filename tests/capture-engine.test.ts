import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ApprovalCaptureEngine,
	CAPTURE_FIELD_CAP_BYTES,
	DEFAULT_CAPTURE_MAX_DISK_BYTES,
	resolveCaptureSettings,
	type CaptureCallInput,
	type CaptureDatasetConfig,
	type ResolvedCaptureSettings,
} from "../extensions/approval-capture.ts";

const NOW = Date.now();

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "pi-capture-test-"));
}

function captureDirOf(home: string): string {
	return join(home, "approval-captures");
}

function makeUuidGen(): () => string {
	let n = 0;
	return () => `${String(++n).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

function makeSettings(overrides: Partial<ResolvedCaptureSettings> = {}): ResolvedCaptureSettings {
	return {
		maxDiskBytes: DEFAULT_CAPTURE_MAX_DISK_BYTES,
		retentionDays: 30,
		scrubSecrets: true,
		retainScrubMap: false,
		syncWrite: false,
		captureSelf: false,
		excludeWorkspaces: [],
		...overrides,
	};
}

function makeEngine(home: string, overrides: Partial<ResolvedCaptureSettings> = {}): ApprovalCaptureEngine {
	return new ApprovalCaptureEngine({ agentDir: home, settings: makeSettings(overrides), pid: process.pid, now: () => NOW, uuid: makeUuidGen() });
}

function readAllRecords(home: string): Array<Record<string, any>> {
	const dir = captureDirOf(home);
	if (!existsSync(dir)) return [];
	const out: Array<Record<string, any>> = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
			if (line) out.push(JSON.parse(line));
		}
	}
	return out;
}

function readRawAll(home: string): string {
	const dir = captureDirOf(home);
	if (!existsSync(dir)) return "";
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => readFileSync(join(dir, name), "utf8"))
		.join("\n");
}

function makeInput(overrides: Partial<CaptureCallInput> = {}): CaptureCallInput {
	return {
		toolName: "read",
		rawArguments: { path: "src/main.ts" },
		rawBranchEntries: [],
		environment: {
			cwd: "/tmp/workspace",
			isProjectTrusted: true,
			approvalMode: "auto",
			registeredTools: ["bash", "read"],
			environmentVars: { PI_APPROVAL_MODE_CAPTURE: "1" },
			denialTrackerStatus: { consecutiveBlocks: 0, consecutiveUnavailable: 0, totalDenials: 0 },
		},
		classifierConfig: {
			stage1ModelResolved: "eval/s1",
			stage2ModelResolved: "eval/s2",
			stage1Thinking: "off",
			stage2Thinking: "off",
			stage1TimeoutMs: 1500,
			stage2TimeoutMs: 3000,
		},
		policies: {},
		...overrides,
	};
}

function outcomeOf(records: Array<Record<string, any>>, callId: string): Record<string, any> {
	const found = records.find((r) => r.eventType === "human_outcome_recorded" && r.callId === callId);
	assert.ok(found, `缺少终局记录: ${callId}`);
	return found;
}

// ==============================================================
// 设置解析（单向开启原则）
// ==============================================================

test("采集设置 - 单向开启原则（全局/env 可开；项目级只能收紧；未受信任禁采）", () => {
	const cfg = (c: CaptureDatasetConfig): CaptureDatasetConfig => c;
	assert.equal(resolveCaptureSettings({ isProjectTrusted: true }), null);
	assert.ok(resolveCaptureSettings({ globalConfig: cfg({ enabled: true }), isProjectTrusted: true }));
	assert.ok(resolveCaptureSettings({ envFlag: "1", isProjectTrusted: true }));
	assert.equal(resolveCaptureSettings({ envFlag: "0", isProjectTrusted: true }), null);
	assert.equal(resolveCaptureSettings({ envFlag: "true", isProjectTrusted: true }), null);
	assert.equal(
		resolveCaptureSettings({ globalConfig: cfg({ enabled: false }), envFlag: "1", isProjectTrusted: true }),
		null,
		"全局显式 false 不可被 env 反开",
	);
	assert.equal(resolveCaptureSettings({ globalConfig: cfg({ enabled: true }), isProjectTrusted: false }), null);
	assert.equal(
		resolveCaptureSettings({ globalConfig: cfg({ enabled: true }), projectConfig: cfg({ enabled: false }), isProjectTrusted: true }),
		null,
		"项目级可收紧关闭",
	);
	assert.equal(resolveCaptureSettings({ projectConfig: cfg({ enabled: true }), isProjectTrusted: true }), null, "项目级不得开启");

	const tightened = resolveCaptureSettings({
		globalConfig: cfg({ enabled: true, maxDiskBytes: 1000, retentionDays: 10 }),
		projectConfig: cfg({ maxDiskBytes: 500, retentionDays: 20 }),
		isProjectTrusted: true,
	});
	assert.equal(tightened?.maxDiskBytes, 500, "项目级可调小配额");
	assert.equal(tightened?.retentionDays, 10, "项目级不可调大保留期");

	const scrub = resolveCaptureSettings({
		globalConfig: cfg({ enabled: true }),
		projectConfig: cfg({ scrubSecrets: false }),
		isProjectTrusted: true,
	});
	assert.equal(scrub?.scrubSecrets, true, "项目级不得放松脱敏");

	const excluded = resolveCaptureSettings({
		globalConfig: cfg({ enabled: true, excludeWorkspaces: ["**/secret-ws/**"] }),
		isProjectTrusted: true,
		cwd: "/home/u/secret-ws/proj",
	});
	assert.equal(excluded, null, "排除名单命中即禁采");
});

// ==============================================================
// 事件 A / B 结构与脱敏
// ==============================================================

test("事件 A - 入口写入物理事实全集（环境/分类器配置/策略 CAS/FS Oracle）", async () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home);
		const handle = engine.startCall(
			makeInput({ policies: { globalPolicyText: "遵循最小权限原则\nAPI_KEY=supersecret1234567890", globalPolicyTruncated: true } }),
		);
		assert.ok(handle);
		await engine.flush();
		const records = readAllRecords(home);
		const eventA = records.find((r) => r.eventType === "tool_call_captured" && r.callId === handle!.callId);
		assert.ok(eventA);
		assert.equal(eventA.rawToolCall.toolName, "read");
		assert.equal(eventA.rawToolCall.rawArguments.path, "src/main.ts");
		assert.ok(typeof eventA.rawToolCall.payloadByteSize === "number" && eventA.rawToolCall.payloadByteSize > 0);
		assert.equal(eventA.environment.approvalMode, "auto");
		assert.equal(eventA.environment.environmentVars.PI_APPROVAL_MODE_CAPTURE, "1");
		assert.equal(eventA.classifierConfig.stage1ModelResolved, "eval/s1");
		assert.equal(eventA.policies.globalPolicyTruncated, true);
		assert.match(eventA.policies.globalPolicyHash, /^[0-9a-f]{64}$/);
		const cas = readFileSync(join(captureDirOf(home), "policies", `${eventA.policies.globalPolicyHash}.md`), "utf8");
		assert.ok(!cas.includes("supersecret1234567890"), "CAS 落盘必须是 scrub 后字节");
		assert.ok(cas.includes("[REDACTED:env-value:"));
		assert.equal(eventA.fsResolutionOracle.targetPath, "src/main.ts");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("全字段脱敏回归：A/B 落盘零明文凭据（工具入参/会话分支/规则文本/模型输出）", async () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home);
		const secret = "sk-abcdefghijklmnop1234";
		const handle = engine.startCall(
			makeInput({
				rawArguments: { command: `curl -H 'X-Key: ${secret}' https://x` },
				rawBranchEntries: [{ type: "message", message: { role: "user", content: `use ${secret} now` } }],
			}),
		);
		assert.ok(handle);
		handle!.noteRuleDecision({ decision: "deny", matchedRule: "Bash(echo token-0123456789abcdef)", matchedLayer: "user" });
		handle!.noteClassifier({ stage: "thinking", shouldBlock: true, reason: "password=hunter2secret" });
		handle!.finishBlocked();
		await engine.flush();
		const raw = readRawAll(home);
		assert.ok(!raw.includes(secret), "工具入参与会话分支中的 API token 不得明文落盘");
		assert.ok(!raw.includes("token-0123456789abcdef"), "matchedRule 文本不得明文落盘");
		assert.ok(!raw.includes("hunter2secret"), "模型输出 reason 不得明文落盘");
		assert.ok(raw.includes("[REDACTED:"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// ==============================================================
// 终局唯一与归因
// ==============================================================

test("终局唯一 - 多次 finish 只落一条事件 B；A/B 以 callId 对账", async () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home);
		const handle = engine.startCall(makeInput());
		assert.ok(handle);
		handle!.finishAllowed();
		handle!.finishBlocked();
		handle!.finishHuman("block", "Edit(x)");
		await engine.flush();
		const records = readAllRecords(home);
		const aRecords = records.filter((r) => r.eventType === "tool_call_captured" && r.callId === handle!.callId);
		const bRecords = records.filter((r) => r.eventType === "human_outcome_recorded" && r.callId === handle!.callId);
		assert.equal(aRecords.length, 1);
		assert.equal(bRecords.length, 1);
		assert.equal(bRecords[0].outcome, "SYSTEM_ALLOWED", "首次 finish 胜出（无规则/分类器/弹窗证据 → 模式放行）");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("终局归因 - 系统阻断四因与放行四类、人工路径、派生快照", async () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home);

		const h1 = engine.startCall(makeInput());
		h1!.noteLoopResult({ isLoop: true, isHardLimit: true, streak: 3 });
		h1!.finishBlocked();

		const h2 = engine.startCall(makeInput());
		h2!.noteLoopResult({ isLoop: true, isHardLimit: false, streak: 2 });
		h2!.noteRuleDecision({ decision: "deny", matchedRule: "Bash(rm -rf *)", matchedLayer: "user" });
		h2!.finishBlocked();

		const h3 = engine.startCall(makeInput());
		h3!.noteRuleDecision({ decision: "ask", matchedRule: "Bash(x)", matchedLayer: "project" });
		h3!.finishBlocked();

		const h4 = engine.startCall(
			makeInput({ environment: { ...makeInput().environment, approvalMode: "readonly" } }),
		);
		h4!.finishBlocked();

		const h5 = engine.startCall(makeInput());
		h5!.noteClassifier({ stage: "fast", shouldBlock: false });
		h5!.finishAllowed();

		const h6 = engine.startCall(makeInput());
		h6!.noteClassifier({ stage: "fallback", shouldBlock: false, reason: "fallback allow" });
		h6!.finishAllowed();

		const h7 = engine.startCall(makeInput());
		h7!.noteRuleDecision({ decision: "allow", matchedRule: "Bash(git status)", matchedLayer: "session" });
		h7!.finishAllowed();

		const h8 = engine.startCall(makeInput());
		h8!.noteDialogShown();
		h8!.finishAllowed();

		const h9 = engine.startCall(makeInput());
		h9!.noteDialogShown();
		h9!.finishHuman("allow_project", "Edit(src/**)");

		const h10 = engine.startCall(makeInput());
		h10!.finishHuman("block_and_abort", "Bash(x)");

		await engine.flush();
		const records = readAllRecords(home);

		const o1 = outcomeOf(records, h1!.callId);
		assert.equal(o1.outcome, "SYSTEM_AUTO_DENIED");
		assert.equal(o1.denialReason, "loop_circuit");
		assert.equal(o1.decisionMaker, "system");
		assert.equal(o1.derived.shortCircuit, "loop_circuit");
		assert.equal(o1.derived.loopDetectorStatus.isLoop, true);

		const o2 = outcomeOf(records, h2!.callId);
		assert.equal(o2.denialReason, "rule_deny", "规则命中优先于 loop 判定");
		assert.equal(o2.decisionMaker, "rule");
		assert.equal(o2.ruleProvenance.scope, "user");
		assert.equal(o2.derived.shortCircuit, "rule_deny");
		assert.equal(o2.derived.matchedRule.layer, "user");
		assert.equal(o2.derived.matchedRule.action, "deny");

		assert.equal(outcomeOf(records, h3!.callId).denialReason, "headless_cap");
		assert.equal(outcomeOf(records, h3!.callId).derived.shortCircuit, "rule_ask");
		assert.equal(outcomeOf(records, h4!.callId).denialReason, "readonly_sandbox");

		const o5 = outcomeOf(records, h5!.callId);
		assert.equal(o5.outcome, "CLASSIFIER_ALLOWED");
		assert.equal(o5.decisionMaker, "classifier");
		assert.equal(o5.derived.derivedSnapshot.systemDecision, "ALLOW");
		assert.ok(o5.derived.derivedSnapshot.stage1Outcome);
		assert.ok(o5.derived.pipelinePath.includes("stage1"));

		assert.equal(outcomeOf(records, h6!.callId).outcome, "FALLBACK_ALLOWED");
		assert.equal(outcomeOf(records, h6!.callId).decisionMaker, "heuristic");

		const o7 = outcomeOf(records, h7!.callId);
		assert.equal(o7.outcome, "RULE_ALLOWED");
		assert.equal(o7.derived.shortCircuit, "rule_allow");

		const o8 = outcomeOf(records, h8!.callId);
		assert.equal(o8.outcome, "SYSTEM_ALLOWED");
		assert.ok(o8.derived.pipelinePath.includes("dialog"));

		const o9 = outcomeOf(records, h9!.callId);
		assert.equal(o9.outcome, "ALLOWED_PROJECT");
		assert.equal(o9.decisionMaker, "human");
		assert.equal(o9.ruleProvenance.scope, "project");
		assert.equal(o9.derived.derivedSnapshot, undefined, "人工路径无分类器派生快照（短路为空）");
		assert.ok(o9.derived.pipelinePath.includes("dialog"));
		assert.equal(outcomeOf(records, h10!.callId).outcome, "REJECTED_AND_ABORT");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("终局归因 - 分类器阻断的派生快照（stage1/stage2 全链路，systemDecision=DENY）", async () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home);
		const handle = engine.startCall(makeInput());
		handle!.noteClassifier({ stage: "thinking", shouldBlock: true, reason: "risky", summary: "summary text" });
		handle!.finishBlocked();
		await engine.flush();
		const snapshot = outcomeOf(readAllRecords(home), handle!.callId).derived.derivedSnapshot;
		assert.equal(snapshot.systemDecision, "DENY");
		assert.equal(snapshot.stage1Outcome.decision, "DENY");
		assert.equal(snapshot.stage2Outcome.shouldBlock, true);
		assert.equal(snapshot.classifierReason, "risky");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// ==============================================================
// 自污染排除 / syncWrite / 终局唯一全量
// ==============================================================

test("自污染排除 - 采集目录与配置的写操作默认零记录；captureSelf=true 时保留并标注", async () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home);
		const dropped = engine.startCall(
			makeInput({ toolName: "write", rawArguments: { path: join(captureDirOf(home), "x.jsonl"), content: "z" } }),
		);
		assert.equal(dropped, null);
		assert.equal(engine.stats.selfCaptureDropped, 1);
		assert.equal(readAllRecords(home).length, 0, "自污染调用零记录");

		const engine2 = makeEngine(home, { captureSelf: true });
		const kept = engine2.startCall(
			makeInput({ toolName: "write", rawArguments: { path: join(captureDirOf(home), "x.jsonl"), content: "z" } }),
		);
		assert.ok(kept);
		kept!.finishAllowed();
		await engine2.flush();
		const record = readAllRecords(home).find((r) => r.callId === kept!.callId && r.eventType === "tool_call_captured");
		assert.equal(record?.selfCapture, true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("syncWrite - 每条事件内联同步落盘（调用返回即可见）", () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home, { syncWrite: true });
		const handle = engine.startCall(makeInput());
		assert.ok(handle);
		const afterA = readAllRecords(home);
		assert.equal(afterA.filter((r) => r.eventType === "tool_call_captured").length, 1, "事件 A 同步落盘");
		handle!.finishAllowed();
		const afterB = readAllRecords(home);
		assert.equal(afterB.filter((r) => r.eventType === "human_outcome_recorded").length, 1, "事件 B 同步落盘");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("终局唯一 - 全部 callId 恰好一条事件 A；已终局者恰好一条事件 B", async () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home);
		const handles = Array.from({ length: 5 }, () => engine.startCall(makeInput()));
		handles[0]!.finishAllowed();
		handles[1]!.finishBlocked();
		handles[2]!.finishHuman("allow_once", "Bash(x)");
		handles[3]!.finishHuman("block", "Bash(y)");
		// handles[4] 不终局——模拟"弹窗进行中"（进程存活，不属于孤儿）
		await engine.flush();
		const records = readAllRecords(home);
		for (let i = 0; i < handles.length; i++) {
			const callId = handles[i]!.callId;
			const aCount = records.filter((r) => r.eventType === "tool_call_captured" && r.callId === callId).length;
			const bCount = records.filter((r) => r.eventType === "human_outcome_recorded" && r.callId === callId).length;
			assert.equal(aCount, 1, `callId ${callId} 应恰有一条事件 A`);
			assert.equal(bCount, i === 4 ? 0 : 1, `callId ${callId} 终局数不符`);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// ==============================================================
// 启动治理：TTL / 配额 / CAS 清扫 / 孤儿对账
// ==============================================================

test("存储治理 - TTL 过期清理与配额淘汰（不动当前进程在写文件）", async () => {
	const home = makeHome();
	try {
		const dir = captureDirOf(home);
		mkdirSync(dir, { recursive: true });
		const ttlFile = join(dir, "2026-01-01-111-aaaaaaaa.jsonl");
		writeFileSync(ttlFile, JSON.stringify({ eventType: "tool_call_captured", callId: "old-1", timestamp: NOW - 3 * 86400000 }) + "\n");
		utimesSync(ttlFile, new Date(NOW - 3 * 86400000), new Date(NOW - 3 * 86400000));
		const big1 = join(dir, "2026-01-02-111-bbbbbbbb.jsonl");
		writeFileSync(big1, `${"x".repeat(1500)}\n`);
		utimesSync(big1, new Date(NOW - 7200000), new Date(NOW - 7200000));
		const big2 = join(dir, "2026-01-03-111-cccccccc.jsonl");
		writeFileSync(big2, `${"y".repeat(1500)}\n`);
		utimesSync(big2, new Date(NOW - 3600000), new Date(NOW - 3600000));

		const engine = makeEngine(home, { retentionDays: 1, maxDiskBytes: 2000 });
		const handle = engine.startCall(makeInput());
		handle!.finishAllowed();
		await engine.flush();
		const summary = await engine.startupMaintenance();
		assert.ok(summary.evictedByTtl >= 1);
		assert.equal(existsSync(ttlFile), false, "过期文件应被清理");
		assert.ok(summary.evictedByQuota >= 1);
		const remaining = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
		assert.ok(
			remaining.some((name) => name.includes(`-${process.pid}-`)),
			"当前进程在写文件绝不被淘汰",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("存储治理 - CAS 策略引用清扫（无引用删除，有引用保留）", async () => {
	const home = makeHome();
	try {
		const dir = captureDirOf(home);
		const policyDir = join(dir, "policies");
		mkdirSync(policyDir, { recursive: true });
		const referencedByOld = "a".repeat(64);
		writeFileSync(join(policyDir, `${referencedByOld}.md`), "referenced by old file");
		const dangling = "c".repeat(64);
		writeFileSync(join(policyDir, `${dangling}.md`), "dangling");
		const oldFile = join(dir, "2026-01-01-111-dddddddd.jsonl");
		writeFileSync(
			oldFile,
			`${JSON.stringify({ eventType: "tool_call_captured", callId: "keep-1", timestamp: NOW, policies: { globalPolicyHash: referencedByOld } })}\n`,
		);

		const engine = makeEngine(home);
		const policyText = "project policy without secrets";
		const expectedHash = createHash("sha256").update(policyText, "utf8").digest("hex");
		const handle = engine.startCall(makeInput({ policies: { globalPolicyText: policyText } }));
		handle!.finishAllowed();
		await engine.flush();
		const summary = await engine.startupMaintenance();
		assert.equal(summary.sweptPolicies, 1, "仅无引用策略被清扫");
		assert.ok(existsSync(join(policyDir, `${referencedByOld}.md`)), "被引用策略保留");
		assert.ok(existsSync(join(policyDir, `${expectedHash}.md`)), "引擎写入并被引用的策略保留");
		assert.equal(existsSync(join(policyDir, `${dangling}.md`)), false, "无引用策略删除");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("孤儿对账 - 双门槛（进程死亡 + 陈旧 24h）与幂等（死而复生拒绝）", async () => {
	const home = makeHome();
	try {
		const dir = captureDirOf(home);
		mkdirSync(dir, { recursive: true });
		const deadPid = 4194305;
		const staleTs = NOW - 25 * 3600000;
		writeFileSync(
			join(dir, `2026-01-01-${deadPid}-aaaaaaaa.jsonl`),
			`${JSON.stringify({ eventType: "tool_call_captured", callId: "orphan-1", timestamp: staleTs })}\n`,
		);
		writeFileSync(
			join(dir, `2026-01-01-${process.pid}-bbbbbbbb.jsonl`),
			`${JSON.stringify({ eventType: "tool_call_captured", callId: "alive-1", timestamp: staleTs })}\n`,
		);
		writeFileSync(
			join(dir, `2026-01-02-${deadPid}-cccccccc.jsonl`),
			`${JSON.stringify({ eventType: "tool_call_captured", callId: "fresh-1", timestamp: NOW - 3600000 })}\n`,
		);
		writeFileSync(
			join(dir, `2026-01-03-${deadPid}-dddddddd.jsonl`),
			`${JSON.stringify({ eventType: "tool_call_captured", callId: "terminated-1", timestamp: staleTs })}\n` +
				`${JSON.stringify({ eventType: "human_outcome_recorded", callId: "terminated-1", outcome: "APPROVED_ONCE", decisionMaker: "human" })}\n`,
		);

		const engine = makeEngine(home);
		const summary = await engine.startupMaintenance();
		assert.equal(summary.orphansWritten, 1, "仅死进程+陈旧且无终局者补写");
		const orphans = readAllRecords(home).filter((r) => r.outcome === "ORPHANED");
		assert.equal(orphans.length, 1);
		assert.equal(orphans[0].callId, "orphan-1");
		assert.equal(orphans[0].decisionMaker, "system");

		const summary2 = await engine.startupMaintenance();
		assert.equal(summary2.orphansWritten, 0, "对账幂等：已有终局永不重复补写");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// ==============================================================
// 韧性、边角与覆盖率补强场景
// ==============================================================

test("引擎默认注入 - 未提供 pid/now/uuid 时使用进程默认（文件名含真实 pid）", async () => {
	const home = makeHome();
	try {
		const engine = new ApprovalCaptureEngine({ agentDir: home, settings: makeSettings() });
		const handle = engine.startCall(makeInput());
		assert.ok(handle);
		handle!.finishAllowed();
		await engine.flush();
		const files = readdirSync(captureDirOf(home)).filter((name) => name.endsWith(".jsonl"));
		assert.equal(files.length, 1);
		assert.match(files[0], new RegExp(`-${process.pid}-[0-9a-f]{8}\\.jsonl$`));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("配置解析 - 非法数值回退默认；异常配置对象与非法排除模式按禁用/忽略兜底", () => {
	const s1 = resolveCaptureSettings({
		globalConfig: { enabled: true, maxDiskBytes: -1 as any, retentionDays: "10" as any },
		isProjectTrusted: true,
	});
	assert.equal(s1?.maxDiskBytes, DEFAULT_CAPTURE_MAX_DISK_BYTES, "非法配额回退默认");
	assert.equal(s1?.retentionDays, 30, "非法保留期回退默认");

	const s2 = resolveCaptureSettings({
		globalConfig: { enabled: true, maxDiskBytes: 1000 },
		projectConfig: { maxDiskBytes: -5 as any },
		isProjectTrusted: true,
	});
	assert.equal(s2?.maxDiskBytes, 1000, "项目级非法值不生效（保持全局基准）");

	const s3 = resolveCaptureSettings({
		globalConfig: new Proxy({}, { get() { throw new Error("boom"); } }),
		isProjectTrusted: true,
	});
	assert.equal(s3, null, "配置读取异常按禁用方向兜底");

	const s4 = resolveCaptureSettings({
		globalConfig: { enabled: true, excludeWorkspaces: ["["] },
		isProjectTrusted: true,
		cwd: "/tmp/ws",
	});
	assert.ok(s4, "非法排除模式不误伤（glob 解析兜底 false）");
});

test("scrubSecrets=false - 显式关闭脱敏时纯深拷贝落盘（警示并忠实执行）", async () => {
	const home = makeHome();
	const savedHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const engine = makeEngine(home, { scrubSecrets: false });
		const secret = "sk-abcdefghijklmnop1234";
		const handle = engine.startCall(
			makeInput({
				rawArguments: { command: `echo ${secret}` },
				rawBranchEntries: [{ type: "message", message: { role: "user", content: `use ${secret}` } }],
			}),
		);
		handle!.finishAllowed();
		await engine.flush();
		const raw = readRawAll(home);
		assert.ok(raw.includes(secret), "显式关闭脱敏时忠实写入原文（全局显式配置的既有语义）");
	} finally {
		process.env.HOME = savedHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("CPU 预算 - 事件处理超限打标（scrubBudgetExceeded）而非降级截断", () => {
	const home = makeHome();
	const savedHome = process.env.HOME;
	process.env.HOME = home;
	try {
		let tick = NOW;
		const engine = new ApprovalCaptureEngine({
			agentDir: home,
			settings: makeSettings({ syncWrite: true }),
			pid: process.pid,
			now: () => (tick += 10),
			uuid: makeUuidGen(),
		});
		const handle = engine.startCall(makeInput());
		assert.ok(handle);
		const eventA = readAllRecords(home).find((r) => r.eventType === "tool_call_captured");
		assert.equal(eventA.scrubBudgetExceeded, true);
		assert.ok(engine.stats.scrubBudgetExceeded >= 1);
	} finally {
		process.env.HOME = savedHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("字段级上限 - 非字符串字段按 JSON 序列化截断并打标 truncatedForStorage", async () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home);
		const bigArray = Array.from({ length: 4000 }, () => "x".repeat(25));
		const handle = engine.startCall(makeInput({ rawArguments: { edits: bigArray } }));
		handle!.finishAllowed();
		await engine.flush();
		const eventA = readAllRecords(home).find((r) => r.eventType === "tool_call_captured");
		assert.equal(eventA.rawToolCall.truncatedForStorage, true);
		assert.equal(typeof eventA.rawToolCall.rawArguments.edits, "string", "超限非字符串字段降级为截断 JSON 文本");
		assert.ok(Buffer.byteLength(eventA.rawToolCall.rawArguments.edits, "utf8") <= CAPTURE_FIELD_CAP_BYTES);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("分支条目 - 事件级预算从最旧端丢弃 + 40 条窗口 + 无时间戳/非 message 条目处置", async () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home);
		const entries: any[] = [];
		for (let i = 0; i < 45; i++) {
			entries.push({
				type: "message",
				message: { role: "user", content: `entry-${i}-${"x".repeat(6000)}` },
				timestamp: i,
			});
		}
		entries.push({ type: "custom", customType: "note" });
		entries.push({ type: "message", message: { role: "system", content: "system note" } });
		entries.push({ type: "message", message: { role: "assistant", content: "no-timestamp" } });
		const handle = engine.startCall(makeInput({ rawBranchEntries: entries }));
		handle!.finishAllowed();
		await engine.flush();
		const eventA = readAllRecords(home).find((r) => r.eventType === "tool_call_captured");
		assert.equal(eventA.branchEntriesTrimmed, true, "事件级预算超限须从最旧端丢弃并打标");
		assert.ok(eventA.rawBranchEntries.length > 0 && eventA.rawBranchEntries.length < 40);
		const last = eventA.rawBranchEntries[eventA.rawBranchEntries.length - 1];
		assert.equal(last.content, "no-timestamp");
		assert.equal(last.timestamp, undefined, "无时间戳条目不虚构时间戳");
		assert.ok(eventA.rawBranchEntries.some((e: any) => typeof e.timestamp === "number"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("人工放行作用域 - allow_session / allow_user 的溯源与标签", async () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home);
		const h1 = engine.startCall(makeInput());
		h1!.finishHuman("allow_session", "Bash(npm test)");
		const h2 = engine.startCall(makeInput());
		h2!.finishHuman("allow_user", "Bash(git status)");
		await engine.flush();
		const records = readAllRecords(home);
		const o1 = outcomeOf(records, h1!.callId);
		assert.equal(o1.outcome, "ALLOWED_SESSION");
		assert.equal(o1.ruleProvenance.scope, "session");
		const o2 = outcomeOf(records, h2!.callId);
		assert.equal(o2.outcome, "ALLOWED_USER");
		assert.equal(o2.ruleProvenance.scope, "user");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("派生快照 - 启发式阻断（FALLBACK_DENY）与 outage 标注；项目层策略 CAS 与截断标志", async () => {
	const home = makeHome();
	try {
		const engine = makeEngine(home);
		const handle = engine.startCall(
			makeInput({ policies: { globalPolicyText: "global note", projectPolicyText: "PROJECT_KEY=abc123456789", projectPolicyTruncated: true } }),
		);
		handle!.noteClassifier({ stage: "fallback", shouldBlock: true, reason: "fallback deny", outage: true });
		handle!.finishBlocked();
		await engine.flush();
		const records = readAllRecords(home);
		const eventA = records.find((r) => r.eventType === "tool_call_captured");
		const eventB = outcomeOf(records, handle!.callId);
		assert.equal(eventB.derived.derivedSnapshot.systemDecision, "FALLBACK_DENY");
		assert.equal(eventB.derived.derivedSnapshot.classifierOutage, true);
		assert.equal(eventB.derived.derivedSnapshot.heuristicOutcome.shouldBlock, true);
		assert.equal(eventA.policies.projectPolicyTruncated, true);
		assert.match(eventA.policies.projectPolicyHash, /^[0-9a-f]{64}$/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("写队列溢出 - 事件 A 丢弃并镜像丢弃事件 B（含终局入队丢弃打点）", async () => {
	const home = makeHome();
	const savedHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const engine = makeEngine(home);
		const handles: Array<ReturnType<ApprovalCaptureEngine["startCall"]>> = [];
		for (let i = 0; i < 260; i++) handles.push(engine.startCall(makeInput()));
		assert.ok(handles.every((h) => h !== null));
		assert.ok(engine.stats.droppedQueue >= 1, "队列满时事件 A 被丢弃计数");
		handles[256]!.finishAllowed(); // 已丢弃句柄：镜像丢弃事件 B
		handles[255]!.finishAllowed(); // 已接受句柄：终局入队仍满 → 丢弃打点
		await engine.flush();
		assert.ok(engine.stats.droppedQueue >= 3);
		assert.equal(engine.stats.writes, 256, "已接受的事件 A 全部落盘");
	} finally {
		process.env.HOME = savedHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("异常韧性 - 构建抛错/循环引用/标注异常均被兜底且不破坏引擎", async () => {
	const home = makeHome();
	const savedHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const engine = makeEngine(home, { syncWrite: true });

		// 1) 构建抛错（Object.entries 触发 ownKeys 陷阱）→ commitRecord 兜底
		const explosiveArgs = new Proxy({}, {
			ownKeys() {
				throw new Error("boom-keys");
			},
		}) as Record<string, unknown>;
		const h1 = engine.startCall(makeInput({ rawArguments: explosiveArgs }));
		assert.ok(h1);
		h1!.finishAllowed(); // 事件 A 未落盘 → 镜像丢弃事件 B
		assert.ok(engine.stats.writeErrors >= 1);

		// 2) 标注异常（枚举型爆炸 getter）不破坏管线
		const explosiveNote = (prop: string): any =>
			Object.defineProperty({}, prop, {
				get() {
					throw new Error(`boom-${prop}`);
				},
				enumerable: true,
			});
		const h2 = engine.startCall(makeInput());
		assert.ok(h2);
		h2!.noteLoopResult(explosiveNote("isLoop"));
		h2!.noteRuleDecision(explosiveNote("decision"));
		h2!.noteClassifier(explosiveNote("stage"));
		h2!.finishAllowed();

		// 3) 循环引用输入 → 序列化/脱敏阶段抛错被任务级兜底
		const cyclic: Record<string, unknown> = { path: "src/x.ts" };
		cyclic.self = cyclic;
		const h3 = engine.startCall(makeInput({ rawArguments: cyclic }));
		assert.ok(h3);
		h3!.finishAllowed();
		await engine.flush();
		assert.ok(engine.stats.writeErrors >= 2, "构建/序列化异常均被计数兜底");
	} finally {
		process.env.HOME = savedHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("治理韧性 - 采集目录被占位为文件时静默降级（不抛异常、失败计数）", async () => {
	const home = makeHome();
	const savedHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const dir = captureDirOf(home);
		mkdirSync(home, { recursive: true });
		writeFileSync(dir, "blocker"); // captureDir 是文件而非目录
		const engine = makeEngine(home);
		const handle = engine.startCall(makeInput());
		assert.ok(handle);
		handle!.finishAllowed();
		await engine.flush();
		const summary = await engine.startupMaintenance();
		assert.equal(summary.orphansWritten, 0);
		assert.ok(engine.stats.writeErrors >= 1, "落盘失败被兜底计数");
	} finally {
		process.env.HOME = savedHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("治理韧性 - 策略目录被占位为文件时 CAS 写入失败但采集继续", async () => {
	const home = makeHome();
	const savedHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const dir = captureDirOf(home);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "policies"), "blocker"); // policyDir 是文件
		const engine = makeEngine(home);
		const handle = engine.startCall(makeInput({ policies: { globalPolicyText: "POLICY_KEY=zzz" } }));
		handle!.finishAllowed();
		await engine.flush();
		const summary = await engine.startupMaintenance();
		assert.equal(summary.sweptPolicies, 0);
		const eventA = readAllRecords(home).find((r) => r.eventType === "tool_call_captured");
		assert.match(eventA.policies.globalPolicyHash, /^[0-9a-f]{64}$/, "CAS 失败不阻断引用哈希记录");
	} finally {
		process.env.HOME = savedHome;
		rmSync(home, { recursive: true, force: true });
	}
});
