import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import approvalModeExtension from "../extensions/approval-mode.ts";

type CaptureRecord = Record<string, any>;

function readCaptureRecords(home: string): CaptureRecord[] {
	const dir = join(home, ".pi", "agent", "approval-captures");
	if (!existsSync(dir)) return [];
	const out: CaptureRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
			if (line) out.push(JSON.parse(line));
		}
	}
	return out;
}

async function waitForCapture(
	home: string,
	predicate: (records: CaptureRecord[]) => boolean,
	timeoutMs = 2000,
): Promise<CaptureRecord[]> {
	const start = Date.now();
	for (;;) {
		const records = readCaptureRecords(home);
		if (predicate(records)) return records;
		if (Date.now() - start > timeoutMs) {
			throw new Error(`等待采集记录超时（当前 ${records.length} 条）`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function enableCapture(home: string): void {
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(home, ".pi", "agent", "approval-config.json"),
		JSON.stringify({ captureDataset: { enabled: true } }),
	);
}

function buildHarness(opts: { cwd: string; mode: string; hasUI: boolean; select?: (body: string) => string | null }) {
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	const dialogs: string[] = [];
	const ctxModel = { provider: "eval", id: "bench-model" };
	const registry = {
		models: [ctxModel],
		find: () => null,
		getAll: () => [ctxModel],
		hasConfiguredAuth: () => true,
		complete: async () => ({
			content: [{ type: "text", text: JSON.stringify({ shouldBlock: false, reason: "ok" }) }],
		}),
	};
	const pi = {
		registerFlag: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		getActiveTools: () => ["bash", "read", "write", "edit"],
		setActiveTools: () => {},
		on: (ev: string, fn: (event: any, ctx: any) => any) => {
			handlers[ev] = fn;
		},
		appendEntry: () => {},
		getFlag: (name: string) => (name === "approval-mode" ? opts.mode : undefined),
	};
	approvalModeExtension(pi as any);
	const ctx: any = {
		modelRegistry: registry,
		model: ctxModel,
		hasUI: opts.hasUI,
		ui: {
			notify: () => {},
			select: async (body: string) => {
				dialogs.push(body);
				return opts.select ? opts.select(body) : "1";
			},
			theme: { fg: (_c: string, t: string) => t },
			setStatus: () => {},
		},
		cwd: opts.cwd,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};
	return { handlers, dialogs, pi, ctx };
}

const SAVED_HOME = process.env.HOME;

test("采集接线 - 默认关闭：工具调用后零记录零目录（禁用态零开销）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-capture-off-"));
	process.env.HOME = home;
	try {
		const harness = buildHarness({ cwd: home, mode: "auto", hasUI: false });
		await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
		await harness.handlers["tool_call"]({ toolName: "read", input: { path: "src/main.ts" }, toolCallId: "t1" }, harness.ctx);
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(
			existsSync(join(home, ".pi", "agent", "approval-captures")),
			false,
			"默认关闭时不得产生任何采集痕迹",
		);
	} finally {
		process.env.HOME = SAVED_HOME;
		rmSync(home, { recursive: true, force: true });
	}
});

test("采集接线 - 快路径放行：事件 A（物理事实）+ 事件 B（SYSTEM_ALLOWED）端到端落盘", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-capture-allow-"));
	process.env.HOME = home;
	try {
		enableCapture(home);
		const harness = buildHarness({ cwd: home, mode: "auto", hasUI: false });
		await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
		const result = await harness.handlers["tool_call"](
			{ toolName: "read", input: { path: "src/main.ts" }, toolCallId: "t2" },
			harness.ctx,
		);
		assert.equal(result, undefined, "工作区内读取快路径应放行");
		const records = await waitForCapture(home, (rs) => rs.some((r) => r.eventType === "human_outcome_recorded"));
		const eventA = records.find((r) => r.eventType === "tool_call_captured");
		const eventB = records.find((r) => r.eventType === "human_outcome_recorded");
		assert.ok(eventA && eventB, "两段式事件均应落盘");
		assert.equal(eventA.rawToolCall.toolName, "read");
		assert.equal(eventA.environment.cwd, home);
		assert.equal(eventB.outcome, "SYSTEM_ALLOWED");
		assert.equal(eventB.decisionMaker, "system");
		assert.equal(eventB.callId, eventA.callId);
		assert.ok(eventB.seq > eventA.seq, "事件 B 序号在事件 A 之后");
		assert.ok(eventB.derived.pipelinePath.includes("loop_check"));
		assert.ok(eventB.derived.pipelinePath.includes("rule_engine"));
		assert.equal(eventB.derived.shortCircuit, undefined);
		assert.equal(eventB.derived.derivedSnapshot, undefined, "未进分类器：派生快照为空");
	} finally {
		process.env.HOME = SAVED_HOME;
		rmSync(home, { recursive: true, force: true });
	}
});

test("采集接线 - deny 规则短路：事件 B 归因 rule_deny（decisionMaker=rule，含规则溯源）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-capture-deny-"));
	process.env.HOME = home;
	try {
		enableCapture(home);
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(
			join(home, ".pi", "agent", "approval-rules.json"),
			JSON.stringify({ deny: ["Bash(rm -rf *)"] }),
		);
		const harness = buildHarness({ cwd: home, mode: "auto", hasUI: false });
		await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
		const result = await harness.handlers["tool_call"](
			{ toolName: "bash", input: { command: "rm -rf build" }, toolCallId: "t3" },
			harness.ctx,
		);
		assert.equal(result?.block, true, "deny 规则应硬性阻断");
		const records = await waitForCapture(home, (rs) => rs.some((r) => r.outcome === "SYSTEM_AUTO_DENIED"));
		const eventB = records.find((r) => r.outcome === "SYSTEM_AUTO_DENIED");
		assert.equal(eventB.denialReason, "rule_deny");
		assert.equal(eventB.decisionMaker, "rule");
		assert.equal(eventB.ruleProvenance.scope, "user");
		assert.equal(eventB.derived.shortCircuit, "rule_deny");
		assert.equal(eventB.derived.matchedRule.action, "deny");
		assert.equal(eventB.derived.matchedRule.layer, "user");
	} finally {
		process.env.HOME = SAVED_HOME;
		rmSync(home, { recursive: true, force: true });
	}
});

test("采集接线 - 人工拒绝：事件 B 归因 REJECTED（decisionMaker=human，含 dialog 轨迹）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-capture-reject-"));
	process.env.HOME = home;
	try {
		enableCapture(home);
		const harness = buildHarness({ cwd: home, mode: "manual", hasUI: true, select: () => "5" });
		await harness.handlers["session_start"]({ reason: "start" }, harness.ctx);
		const result = await harness.handlers["tool_call"](
			{ toolName: "bash", input: { command: "echo hi" }, toolCallId: "t4" },
			harness.ctx,
		);
		assert.equal(result?.block, true, "人工弹窗拒绝应阻断");
		assert.ok(harness.dialogs.length >= 1, "应弹出人工审批对话框");
		const records = await waitForCapture(home, (rs) => rs.some((r) => r.outcome === "REJECTED"));
		const eventA = records.find((r) => r.eventType === "tool_call_captured");
		const eventB = records.find((r) => r.outcome === "REJECTED");
		assert.equal(eventA.rawToolCall.rawArguments.command, "echo hi");
		assert.equal(eventB.decisionMaker, "human");
		assert.ok(eventB.derived.pipelinePath.includes("dialog"));
		assert.equal(eventB.derived.derivedSnapshot, undefined);
	} finally {
		process.env.HOME = SAVED_HOME;
		rmSync(home, { recursive: true, force: true });
	}
});
