import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteCaptureRecords, exportCaptureRecords } from "../extensions/approval-capture.ts";

function makeHome(): string {
	return mkdtempSync(join(tmpdir(), "pi-dataset-tools-"));
}

function captureDirOf(home: string): string {
	return join(home, "approval-captures");
}

interface FixtureRecord {
	eventType: string;
	callId: string;
	timestamp: number;
	seq?: number;
	[key: string]: unknown;
}

function eventA(callId: string, timestamp: number, extra: Record<string, unknown> = {}): FixtureRecord {
	return { eventType: "tool_call_captured", callId, timestamp, seq: 1, ...extra };
}

function eventB(callId: string, timestamp: number): FixtureRecord {
	return { eventType: "human_outcome_recorded", callId, timestamp, outcome: "APPROVED_ONCE", decisionMaker: "human" };
}

function writeFixture(captureDir: string, fileName: string, records: FixtureRecord[]): void {
	mkdirSync(captureDir, { recursive: true });
	writeFileSync(join(captureDir, fileName), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function readAllRecords(home: string): FixtureRecord[] {
	const dir = captureDirOf(home);
	if (!existsSync(dir)) return [];
	const out: FixtureRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
			if (line) out.push(JSON.parse(line));
		}
	}
	return out;
}

test("删除权 - 按 callId 精确删除（A/B 成对移除）并清扫失去引用的 CAS 策略", () => {
	const home = makeHome();
	try {
		const dir = captureDirOf(home);
		const policyDir = join(dir, "policies");
		mkdirSync(policyDir, { recursive: true });
		const hashA = "a".repeat(64);
		const hashB = "b".repeat(64);
		writeFileSync(join(policyDir, `${hashA}.md`), "policy A");
		writeFileSync(join(policyDir, `${hashB}.md`), "policy B");
		writeFixture(dir, "2026-01-01-111-aaaaaaaa.jsonl", [
			eventA("call-1", 1000, { policies: { globalPolicyHash: hashA } }),
			eventB("call-1", 1100),
			eventA("call-2", 2000, { policies: { globalPolicyHash: hashB } }),
			eventB("call-2", 2100),
		]);

		const summary = deleteCaptureRecords(dir, { callIds: ["call-1"] });
		assert.equal(summary.recordsRemoved, 2);
		const remaining = readAllRecords(home);
		assert.equal(remaining.length, 2);
		assert.ok(remaining.every((r) => r.callId === "call-2"));
		assert.equal(summary.policiesSwept, 1);
		assert.equal(existsSync(join(policyDir, `${hashA}.md`)), false, "失去引用的策略被清扫");
		assert.ok(existsSync(join(policyDir, `${hashB}.md`)), "仍被引用的策略保留");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("删除权 - 时间范围与安全纪律（空范围拒绝、全量需显式确认）", () => {
	const home = makeHome();
	try {
		const dir = captureDirOf(home);
		writeFixture(dir, "2026-01-01-111-bbbbbbbb.jsonl", [
			eventA("old-1", 1000),
			eventB("old-1", 1100),
			eventA("new-1", 3000),
			eventB("new-1", 3100),
		]);

		const scoped = deleteCaptureRecords(dir, { beforeMs: 2000 });
		assert.equal(scoped.recordsRemoved, 2, "仅删除时间点及之前的记录");
		assert.ok(readAllRecords(home).every((r) => r.callId === "new-1"));

		assert.throws(() => deleteCaptureRecords(dir, {}), /范围为空/);
		assert.throws(() => deleteCaptureRecords(dir, { all: true }), /确认/);

		const all = deleteCaptureRecords(dir, { all: true, confirmAll: true });
		assert.ok(all.recordsRemoved >= 2);
		assert.equal(all.filesEmptied, 1, "清空后的文件被移除");
		assert.equal(readAllRecords(home).length, 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("导出权 - 二次脱敏生效（对未脱敏存量记录重扫同一管道）与筛选语义", () => {
	const home = makeHome();
	try {
		const dir = captureDirOf(home);
		const secret = "sk-abcdefghijklmnop1234";
		// 手工写入一条"未脱敏"存量记录（模拟历史/外部数据），验证导出前二次脱敏
		writeFixture(dir, "2026-01-01-111-cccccccc.jsonl", [
			eventA("legacy-1", 1000, { rawToolCall: { toolName: "bash", rawArguments: { command: `curl -H 'X-Key: ${secret}' https://x` } } }),
			eventB("legacy-1", 1100),
			eventA("call-2", 2000, { policies: {} }),
			eventB("call-2", 2100),
		]);

		const outAll = join(home, "export-all.jsonl");
		const summaryAll = exportCaptureRecords(dir, {}, outAll);
		assert.equal(summaryAll.recordsExported, 4);
		assert.equal(summaryAll.callsExported, 2);
		const exported = readFileSync(outAll, "utf8");
		assert.ok(!exported.includes(secret), "导出前二次脱敏必须生效");
		assert.ok(exported.includes("[REDACTED:api-token:"));

		const outFiltered = join(home, "export-filtered.jsonl");
		const summaryFiltered = exportCaptureRecords(dir, { callIds: ["call-2"] }, outFiltered);
		assert.equal(summaryFiltered.recordsExported, 2);
		assert.equal(summaryFiltered.callsExported, 1);

		assert.throws(() => exportCaptureRecords(dir, { callIds: ["missing"] }, join(home, "x.jsonl")), /范围为空/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
