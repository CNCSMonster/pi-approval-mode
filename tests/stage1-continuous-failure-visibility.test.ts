import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import approvalModeExtension from "../extensions/approval-mode.ts";
import {
	StageHealthTracker,
	STAGE1_ESCALATE_THRESHOLD,
} from "../extensions/classifier-projection.ts";

const sandboxHome = mkdtempSync(join(tmpdir(), "pi-issue-0042-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

interface Harness {
	handlers: Record<string, any>;
	commands: Record<string, any>;
	notices: { msg: string; level?: string }[];
	statuses: string[];
	ctx: any;
	classifyCalls: () => number;
}

async function setupHarness(opts: {
	complete?: (stagePrompt: string, callCount: number) => Promise<any>;
}): Promise<Harness> {
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};

	const pi = {
		registerFlag: () => {},
		registerCommand: (name: string, def: any) => {
			commands[name] = def;
		},
		registerShortcut: () => {},
		getActiveTools: () => ["bash", "edit", "write", "read"],
		setActiveTools: () => {},
		on: (event: string, handler: Function) => {
			handlers[event] = handler;
		},
		appendEntry: () => {},
		getFlag: (name: string) => (name === "approval-mode" ? "auto" : undefined),
	};
	approvalModeExtension(pi as any);

	const ctxModel = { provider: "ctx", id: "main" };
	let callCount = 0;
	const registry = {
		models: [ctxModel],
		find: () => null,
		getAll: () => [ctxModel] as any[],
		hasConfiguredAuth: () => true,
		complete: async (_model: any, prompt: any) => {
			callCount++;
			if (opts.complete) {
				const sysPrompt = prompt.systemPrompt || "";
				return await opts.complete(sysPrompt, callCount);
			}
			return {
				content: [{ type: "text", text: '{"shouldBlock": false, "reason": "default allow"}' }],
			};
		},
	};

	const notices: { msg: string; level?: string }[] = [];
	const statuses: string[] = [];

	const ctx: any = {
		modelRegistry: registry,
		model: ctxModel,
		hasUI: true,
		ui: {
			notify: (msg: string, level?: string) => notices.push({ msg, level }),
			select: async () => null,
			theme: { fg: (_c: string, t: string) => t },
			setStatus: (_k: string, s: string) => statuses.push(s),
		},
		cwd: "/test",
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	const agentDir = join(sandboxHome, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });

	await handlers["session_start"]({ reason: "start" }, ctx);
	return { handlers, commands, notices, statuses, ctx, classifyCalls: () => callCount };
}

// =========================================================================
// 单元测试: StageHealthTracker 阶梯升级逻辑与阈值复位
// =========================================================================

test("StageHealthTracker 连续 5 次阶梯升级判断与成功复位", () => {
	const tracker = new StageHealthTracker();
	assert.strictEqual(STAGE1_ESCALATE_THRESHOLD, 5, "阶梯升级阈值必须为 5");

	// 1. 首次失败：transitioned 为 true，escalated 为 false
	const r1 = tracker.recordStage1Failure("timeout");
	assert.strictEqual(r1.transitioned, true, "第 1 次应发生 healthy -> degraded 跃迁");
	assert.strictEqual(r1.escalated, false);
	assert.strictEqual(tracker.hasEscalated(), false);

	// 2. 第 2~4 次失败：transitioned 为 false，escalated 为 false
	for (let i = 2; i <= 4; i++) {
		const r = tracker.recordStage1Failure("invalid_response");
		assert.strictEqual(r.transitioned, false, `第 ${i} 次不应有状态跃迁`);
		assert.strictEqual(r.escalated, false, `第 ${i} 次未达 5 次阈值`);
	}
	assert.strictEqual(tracker.getStatus().consecutiveFailures, 4);

	// 3. 第 5 次失败：触发阶梯升级
	const r5 = tracker.recordStage1Failure("upstream_error");
	assert.strictEqual(r5.transitioned, false);
	assert.strictEqual(r5.escalated, true, "第 5 次连续失败必须触发 escalated");
	assert.strictEqual(tracker.hasEscalated(), true);

	// 4. 第 6 次失败：升级标记去重，不再重复触发 escalated
	const r6 = tracker.recordStage1Failure("exception");
	assert.strictEqual(r6.escalated, false, "第 6 次失败不得重复触发 escalated");

	// 5. 成功恢复：彻底重置连续失败与升级标记
	tracker.recordStage1Success();
	const recovered = tracker.getStatus();
	assert.strictEqual(recovered.status, "healthy");
	assert.strictEqual(recovered.consecutiveFailures, 0);
	assert.strictEqual(recovered.totalFailures, 6, "累计失败总数应保留");
	assert.strictEqual(tracker.hasEscalated(), false, "成功后 escalated 标记必须复位");
	assert.strictEqual(tracker.hasWarnedDegraded(), false, "成功后 warnedDegraded 必须复位");

	// 6. 恢复后再次经历失败：可重新触发完整的初次跃迁与 5 次升级
	const rNew1 = tracker.recordStage1Failure("timeout");
	assert.strictEqual(rNew1.transitioned, true, "恢复后再失败应重新发生跃迁");
	for (let i = 2; i <= 4; i++) {
		tracker.recordStage1Failure("timeout");
	}
	const rNew5 = tracker.recordStage1Failure("timeout");
	assert.strictEqual(rNew5.escalated, true, "恢复后连续 5 次再次触发升级");

	// 7. reset 全量清理
	tracker.reset();
	assert.strictEqual(tracker.getStatus().status, "healthy");
	assert.strictEqual(tracker.getStatus().consecutiveFailures, 0);
	assert.strictEqual(tracker.getStatus().totalFailures, 0);
	assert.strictEqual(tracker.hasEscalated(), false);
});

// =========================================================================
// 端到端测试: 状态栏常驻 [⚖️ auto | S1⚠️]、连续 5 次升级告警与绝不阻塞 Agent
// =========================================================================

test(" e2e: Stage 1 异常时状态栏联动 [⚖️ auto | S1⚠️]，连续 5 次阶梯升级，且全程不阻塞 Agent", async () => {
	let stage1Calls = 0;
	let stage2Calls = 0;
	let stage1SimulateFail = true;

	const h = await setupHarness({
		complete: async (sysPrompt) => {
			if (sysPrompt.includes("stage 2 will review uncertain blocks")) {
				stage1Calls++;
				if (stage1SimulateFail) {
					// 模拟 Stage 1 解析失败异常
					return { content: [{ type: "text", text: "INVALID_JSON_ERROR" }] };
				}
				// 模拟 Stage 1 恢复正常
				return { content: [{ type: "text", text: '{"shouldBlock": false}' }] };
			}
			stage2Calls++;
			// Stage 2 始终正常放行，验证 Agent 全程不被阻断
			return { content: [{ type: "text", text: '{"shouldBlock": false, "reason": "stage2 pass"}' }] };
		},
	});

	// 开局健康状态：状态栏为 [⚖️ auto]
	assert.strictEqual(h.statuses[h.statuses.length - 1], "[⚖️ auto]");

	// --- 调用 1: Stage 1 首次异常 ---
	const r1 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "echo test1" } }, h.ctx);
	assert.strictEqual(r1, undefined, "Stage 1 异常时由 Stage 2 接管，工具调用必须放行（不阻塞 Agent）");
	assert.strictEqual(stage1Calls, 1);
	assert.strictEqual(stage2Calls, 1);

	// 验证 1: 状态栏变为 [⚖️ auto | S1⚠️]
	assert.strictEqual(h.statuses[h.statuses.length - 1], "[⚖️ auto | S1⚠️]", "首次异常后状态栏必须联动常驻 S1⚠️ 徽标");

	// 验证 2: 收到首条通知
	const noticesInitial = h.notices.filter((n) => n.msg.includes("Stage 1 快速快筛响应异常"));
	assert.strictEqual(noticesInitial.length, 1, "必须收到首次跃迁通知");

	// --- 调用 2~4: Stage 1 持续异常，告警去重不刷屏，状态栏常驻，Agent 不被阻塞 ---
	for (let i = 2; i <= 4; i++) {
		const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: `echo test${i}` } }, h.ctx);
		assert.strictEqual(r, undefined, `第 ${i} 次调用 Stage 2 接管正常放行`);
		assert.strictEqual(h.statuses[h.statuses.length - 1], "[⚖️ auto | S1⚠️]", "状态栏持续显示 S1⚠️ 徽标");
	}
	// 通知数量依然是 1 条，无重复刷屏
	assert.strictEqual(h.notices.filter((n) => n.msg.includes("Stage 1 快速快筛响应异常")).length, 1);
	assert.strictEqual(h.notices.filter((n) => n.msg.includes("已连续失败 5 次")).length, 0);

	// --- 调用 5: 达到连续 5 次阈值，触发阶梯升级提醒 ---
	const r5 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "echo test5" } }, h.ctx);
	assert.strictEqual(r5, undefined, "达到 5 次故障时依然不阻塞 Agent 工作");

	const escalateNotices = h.notices.filter((n) => n.msg.includes("已连续失败 5 次"));
	assert.strictEqual(escalateNotices.length, 1, "第 5 次连续失败必须触发阶梯升级告警通知");
	assert.match(escalateNotices[0].msg, /\/classifier-model/, "升级通知必须包含 /classifier-model 检查指引");
	assert.match(escalateNotices[0].msg, /审批延迟增加/, "升级通知必须提示延迟增加影响");

	// --- 调用 6: 持续失败第 6 次，升级告警去重不重复触发 ---
	const r6 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "echo test6" } }, h.ctx);
	assert.strictEqual(r6, undefined);
	assert.strictEqual(h.notices.filter((n) => n.msg.includes("已连续失败 5 次")).length, 1, "升级告警不得重复发送");

	// --- 调用 7: Stage 1 服务恢复正常 ---
	stage1SimulateFail = false;
	const r7 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "echo test7" } }, h.ctx);
	assert.strictEqual(r7, undefined, "恢复后正常放行");

	// 验证恢复：状态栏自动复原为 [⚖️ auto]
	assert.strictEqual(h.statuses[h.statuses.length - 1], "[⚖️ auto]", "Stage 1 恢复成功后状态栏必须自动复原为 [⚖️ auto]");
});
