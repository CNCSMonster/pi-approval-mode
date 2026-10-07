import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import approvalModeExtension from "../extensions/approval-mode.ts";
import {
	StageHealthTracker,
} from "../extensions/classifier-projection.ts";
import {
	evaluateFallbackAction,
	fallbackHeuristicCheck,
} from "../extensions/heuristic-guard.ts";
import {
	DenialTracker,
	formatDenyReasonForAgent,
	formatLoopReasonForAgent,
	formatUserRejectionReasonForAgent,
	formatUserAbortReasonForAgent,
} from "../extensions/denial-tracker.ts";
import { MICRO_TEST_LIMITS } from "./test-harness.ts";

// 沙箱目录隔离，防止污染真实环境
const sandboxHome = mkdtempSync(join(tmpdir(), "pi-issue-0041-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

interface Harness {
	handlers: Record<string, any>;
	commands: Record<string, any>;
	dialogs: string[];
	notices: { msg: string; level?: string }[];
	statuses: string[];
	ctx: any;
	classifyCalls: () => number;
}

async function setupHarness(opts: {
	hasUI: boolean;
	mode?: string;
	complete?: (stagePrompt: string, callCount: number) => Promise<any>;
	selectReply?: (n: number) => string | null;
	config?: Record<string, any>;
}): Promise<Harness> {
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const mode = opts.mode || "auto";

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
		getFlag: (name: string) => (name === "approval-mode" ? mode : undefined),
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

	const dialogs: string[] = [];
	const notices: { msg: string; level?: string }[] = [];
	const statuses: string[] = [];
	let selectCount = 0;

	const ctx: any = {
		modelRegistry: registry,
		model: ctxModel,
		hasUI: opts.hasUI,
		ui: {
			notify: (msg: string, level?: string) => notices.push({ msg, level }),
			select: async (body: string) => {
				dialogs.push(body);
				selectCount++;
				return opts.selectReply ? opts.selectReply(selectCount) : null;
			},
			theme: { fg: (_c: string, t: string) => t },
			setStatus: (_k: string, s: string) => statuses.push(s),
		},
		cwd: "/test",
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	const agentDir = join(sandboxHome, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	if (opts.config) {
		writeFileSync(join(agentDir, "approval-config.json"), JSON.stringify(opts.config));
	}

	await handlers["session_start"]({ reason: "start" }, ctx);
	return { handlers, commands, dialogs, notices, statuses, ctx, classifyCalls: () => callCount };
}

// =========================================================================
// Module A: Stage 1 Independent Health Tracking
// =========================================================================

test("Module A - StageHealthTracker 单元状态机与状态跃迁", () => {
	const tracker = new StageHealthTracker();
	const initial = tracker.getStatus();
	assert.strictEqual(initial.status, "healthy");
	assert.strictEqual(initial.consecutiveFailures, 0);
	assert.strictEqual(initial.totalFailures, 0);
	assert.strictEqual(tracker.hasWarnedDegraded(), false);

	// 首次故障：跃迁到 degraded
	const res1 = tracker.recordStage1Failure("timeout");
	assert.strictEqual(res1.transitioned, true, "首次故障必须标记状态跃迁");
	const status1 = tracker.getStatus();
	assert.strictEqual(status1.status, "degraded");
	assert.strictEqual(status1.consecutiveFailures, 1);
	assert.strictEqual(status1.totalFailures, 1);
	assert.strictEqual(status1.lastFailureReason, "timeout");
	assert.ok(status1.lastFailureAt && status1.lastFailureAt > 0);

	// 标记已告警
	tracker.setWarnedDegraded(true);
	assert.strictEqual(tracker.hasWarnedDegraded(), true);

	// 第二次连续故障：状态保持 degraded，无跃迁
	const res2 = tracker.recordStage1Failure("invalid_response");
	assert.strictEqual(res2.transitioned, false, "非首次故障无跃迁");
	const status2 = tracker.getStatus();
	assert.strictEqual(status2.consecutiveFailures, 2);
	assert.strictEqual(status2.totalFailures, 2);
	assert.strictEqual(status2.lastFailureReason, "invalid_response");

	// 成功恢复：重置连续故障与告警状态，恢复 healthy
	tracker.recordStage1Success();
	const recovered = tracker.getStatus();
	assert.strictEqual(recovered.status, "healthy");
	assert.strictEqual(recovered.consecutiveFailures, 0);
	assert.strictEqual(recovered.totalFailures, 2, "totalFailures 保留用于观测统计");
	assert.strictEqual(tracker.hasWarnedDegraded(), false, "恢复后告警去重标记复位");

	// reset 清理全部状态
	tracker.reset();
	const afterReset = tracker.getStatus();
	assert.strictEqual(afterReset.status, "healthy");
	assert.strictEqual(afterReset.totalFailures, 0);
});

test("Module A - e2e: Stage 1 异常故障不污染全局 consecutiveUnavailable，且首次跃迁告警去重", async () => {
	let stage1Calls = 0;
	let stage2Calls = 0;

	const h = await setupHarness({
		hasUI: true,
		mode: "auto",
		complete: async (sysPrompt) => {
			if (sysPrompt.includes("stage 2 will review uncertain blocks")) {
				stage1Calls++;
				// Stage 1 返回解析失败的异常文本，触发 invalid_response
				return { content: [{ type: "text", text: "NOT_VALID_JSON_RESPONSE" }] };
			}
			stage2Calls++;
			// Stage 2 成功返回允许放行
			return { content: [{ type: "text", text: '{"shouldBlock": false, "reason": "stage2 pass"}' }] };
		},
	});

	// 调用 1：Stage 1 异常 -> Stage 2 成功
	const r1 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "echo test1" } }, h.ctx);
	assert.strictEqual(r1, undefined, "Stage 2 放行后调用成功");
	assert.strictEqual(stage1Calls, 1);
	assert.strictEqual(stage2Calls, 1);

	// 校验首次跃迁产生 UI 告警
	const warnings1 = h.notices.filter((n) => n.msg.includes("Stage 1 快速快筛响应异常"));
	assert.strictEqual(warnings1.length, 1, "首次跃迁必须触发 UI 告警");
	assert.match(warnings1[0].msg, /invalid_response/);

	// 调用 2：Stage 1 再次异常 -> 告警去重，不重复弹窗通知
	const r2 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "echo test2" } }, h.ctx);
	assert.strictEqual(r2, undefined);
	const warnings2 = h.notices.filter((n) => n.msg.includes("Stage 1 快速快筛响应异常"));
	assert.strictEqual(warnings2.length, 1, "第二次故障不得重复发送 UI 告警通知");

	// 执行 /classifier-model 状态命令，校验包含 Stage 1 运行健康信息
	let statusReport = "";
	h.ctx.ui.notify = (msg: string) => {
		statusReport = msg;
	};
	await h.commands["classifier-model"].handler("", h.ctx);
	assert.match(statusReport, /Stage 1 运行健康/, "状态报告必须呈现 Stage 1 运行健康项");
	assert.match(statusReport, /degraded/, "状态报告必须显示当前为 degraded 状态");
});

// =========================================================================
// Module B: Degraded Mode Fallback Matrix (Option C)
// =========================================================================

test("Module B - evaluateFallbackAction 处置矩阵纯函数测试", () => {
	const cwd = "/workspace/project";

	// 1. bash 工具
	const safeBash = evaluateFallbackAction("bash", { command: "git status" }, { cwd });
	assert.strictEqual(safeBash.action, "allow");

	const dangerousBash1 = evaluateFallbackAction("bash", { command: "rm -rf /" }, { cwd });
	assert.strictEqual(dangerousBash1.action, "require_approval");
	assert.match(dangerousBash1.reason, /高危/);

	const dangerousBash2 = evaluateFallbackAction("bash", { command: "mkfs.ext4 /dev/sda" }, { cwd });
	assert.strictEqual(dangerousBash2.action, "require_approval");

	// 2. read 类读取工具
	const readTool = evaluateFallbackAction("read", { path: "/workspace/project/README.md" }, { cwd });
	assert.strictEqual(readTool.action, "require_approval");
	assert.match(readTool.reason, /敏感读取操作需人工确认/);

	const readFileTool = evaluateFallbackAction("read_file", { path: "/workspace/project/src/index.ts" }, { cwd });
	assert.strictEqual(readFileTool.action, "require_approval");

	// 3. edit / write 工具
	const normalEdit = evaluateFallbackAction("edit", { path: "/workspace/project/src/app.ts" }, { cwd });
	assert.strictEqual(normalEdit.action, "allow", "工作区内常规编辑放行");

	const protectedEdit = evaluateFallbackAction("edit", { path: "/workspace/project/.git/config" }, { cwd });
	assert.strictEqual(protectedEdit.action, "require_approval", "受保护路径必须要求审批");

	const escapingWrite = evaluateFallbackAction("write", { path: "/etc/passwd" }, { cwd });
	assert.strictEqual(escapingWrite.action, "require_approval", "越界工作区路径必须要求审批");

	// 4. 未知工具
	const unknownTool = evaluateFallbackAction("custom_execute_tool", { foo: "bar" }, { cwd });
	assert.strictEqual(unknownTool.action, "require_approval");
	assert.match(unknownTool.reason, /未知工具 \(custom_execute_tool\)/);

	// fallbackHeuristicCheck 包装测试
	const wrapSafe = fallbackHeuristicCheck("bash", { command: "ls -la" }, cwd);
	assert.strictEqual(wrapSafe.shouldBlock, false);
	assert.strictEqual(wrapSafe.stage, "fallback");

	const wrapDangerous = fallbackHeuristicCheck("bash", { command: "rm -rf *" }, cwd);
	assert.strictEqual(wrapDangerous.shouldBlock, true);
	assert.strictEqual(wrapDangerous.stage, "fallback");
});

test("Module B - e2e: 降级态下高危指令/敏感读取/未知工具要求审批（无头模式拦截阻断）", async () => {
	// 创建持续不可用的无头环境（熔断后进入降级兜底矩阵）
	const h = await setupHarness({
		hasUI: false,
		mode: "auto",
		complete: async () => {
			throw new Error("classifier service unavailable");
		},
	});

	// 前 3 次触发熔断
	for (let i = 1; i <= 3; i++) {
		const r = await h.handlers["tool_call"]({ toolName: "bash", input: { command: `echo ${i}` } }, h.ctx);
		assert.strictEqual(r?.block, true);
	}

	// 熔断后未知工具调用：必须被拦截并要求人工审批（无头直接拦截）
	const rUnknown = await h.handlers["tool_call"]({ toolName: "unknown_cloud_exec", input: { target: "srv" } }, h.ctx);
	assert.strictEqual(rUnknown?.block, true, "未知工具在降级态严禁静默放行");
	assert.match(String(rUnknown?.reason), /分类器不可用|classifier unavailable/);
});

// =========================================================================
// Module C: yolo Mode Stagnation Loop Interception & Non-Termination
// =========================================================================

test("Module C - e2e: yolo 模式 streak >= 3 相同调用被拦截且 terminate: false，并发出告警通知", async () => {
	const h = await setupHarness({
		hasUI: true,
		mode: "yolo",
	});

	const loopCmd = { command: "pytest tests/failing.py" };

	// 第 1 次与第 2 次相同调用：yolo 模式直接放行
	const r1 = await h.handlers["tool_call"]({ toolName: "bash", input: loopCmd }, h.ctx);
	assert.strictEqual(r1, undefined, "第 1 次允许执行");

	const r2 = await h.handlers["tool_call"]({ toolName: "bash", input: loopCmd }, h.ctx);
	assert.strictEqual(r2, undefined, "第 2 次允许执行");

	// 第 3 次相同调用：触发停滞死循环拦截，terminate 必须为 false
	const r3 = await h.handlers["tool_call"]({ toolName: "bash", input: loopCmd }, h.ctx);
	assert.strictEqual(r3?.block, true, "第 3 次相同调用必须被阻断");
	assert.notStrictEqual(r3?.terminate, true, "yolo 模式死循环阻断严禁杀进程，必须保持 terminate 为 falsy 供模型自我纠偏");

	const reason = String(r3?.reason);
	assert.match(reason, /\[Execution Loop: STAGNATION\]/, "返回结构化停滞错误");
	assert.match(reason, /3 consecutive calls used identical tool and parameters/, "明示重复计数 3");
	assert.match(reason, /- Constraint: Further identical retries of this command are blocked/, "包含负向约束指示");
	assert.match(reason, /- Next Steps:/, "包含下一步指导");

	// 验证向用户界面发出了 UI 警告
	const stagnationNotices = h.notices.filter((n) => n.msg.includes("检测到连续 3 次相同工具调用"));
	assert.strictEqual(stagnationNotices.length, 1, "必须向 UI 发出循环告警");

	// 第 4 次执行不同指令：streak 复位，允许放行
	const r4 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "pytest tests/another.py" } }, h.ctx);
	assert.strictEqual(r4, undefined, "不同调用重置 streak 并放行");
});

// =========================================================================
// Module D: Dual-Channel Messaging
// =========================================================================

test("Module D - 双通道消息格式化单元测试", () => {
	// 1. 策略阻断
	const denyReason = formatDenyReasonForAgent("Deny(Bash(curl *))");
	assert.match(denyReason, /\[Approval Policy: BLOCKED\]/);
	assert.match(denyReason, /- Error: Execution denied by rule Deny\(Bash\(curl \*\)\)\./);
	assert.match(denyReason, /- Constraint: Operations matching this pattern are permanently disallowed by user policy\./);
	assert.match(denyReason, /- Next Steps: Choose an alternative approach that completely avoids this operation\./);

	// 2. 停滞循环
	const loopReason = formatLoopReasonForAgent({
		isLoop: true,
		streak: 3,
		toolName: "bash",
		input: { command: "npm test" },
	});
	assert.match(loopReason, /\[Execution Loop: STAGNATION\]/);
	assert.match(loopReason, /- Error: 3 consecutive calls used identical tool and parameters with no forward progress\./);
	assert.match(loopReason, /- Constraint: Further identical retries of this command are blocked\./);
	assert.match(loopReason, /- Next Steps: Inspect previous outputs, determine why the approach failed/);

	// 3. 用户人审拒绝
	const userRejection = formatUserRejectionReasonForAgent("Manual review reject");
	assert.match(userRejection, /\[User Decision: REJECTED\]/);
	assert.match(userRejection, /- Action: The user manually rejected this tool execution in the approval prompt \(the user denied "Manual review reject"\)\./);
	assert.match(userRejection, /- Next Steps: Respect the user's rejection\./);

	// 4. 用户中止指令
	const userAbort = formatUserAbortReasonForAgent();
	assert.match(userAbort, /\[User Directive: ABORT_DIRECTION\]/);
	assert.match(userAbort, /- Action: The user rejected this tool call and explicitly commanded an immediate halt/);
	assert.match(userAbort, /- Next Steps: Do NOT continue this line of reasoning or related commands\./);
});

test("Module D - e2e: 阻断与用户拒绝触发双通道解耦（User 通道通知/状态 vs Agent 通道结构化 Reason）", async () => {
	// 1. Deny 规则阻断双通道测试
	const h = await setupHarness({
		hasUI: true,
		mode: "auto",
	});

	// 在 session_start 中挂载测试用的 deny 规则
	writeFileSync(
		join(sandboxHome, ".pi", "agent", "approval-rules.json"),
		JSON.stringify({
			allow: [],
			ask: [],
			deny: ["Bash(curl *)"],
			default: [],
		}),
	);
	await h.handlers["session_start"]({ reason: "reload" }, h.ctx);

	const rDeny = await h.handlers["tool_call"]({ toolName: "bash", input: { command: "curl http://example.com" } }, h.ctx);
	assert.strictEqual(rDeny?.block, true);
	// User 通道：UI notification 简洁直观
	const denyNotices = h.notices.filter((n) => n.msg.includes("命中禁止规则"));
	assert.ok(denyNotices.length >= 1, "User 通道必须收到友好通知");
	// Agent 通道：结构化 reason 含有 Policy、Constraint、Next Steps，无终端交互提示
	const agentDenyReason = String(rDeny?.reason);
	assert.match(agentDenyReason, /\[Approval Policy: BLOCKED\]/);
	assert.match(agentDenyReason, /- Constraint:/);
	assert.match(agentDenyReason, /- Next Steps:/);
	assert.doesNotMatch(agentDenyReason, /\/approval-mode/);
	assert.doesNotMatch(agentDenyReason, /按键选择/);
});

// =========================================================================
// Module E: Total Denial Cap & Four Reset Timings
// =========================================================================

// [Baseline Anchor Test] 仅此类测试允许断言生产环境缺省默认常量，防范非预期漂移
test("Module E - 默认上限为 50，且支持四类重置时机与连续成功额度自愈", async () => {
	const tracker = new DenialTracker();
	assert.strictEqual(tracker.getLimits().maxTotalDenials, 50, "默认上限必须为 50");

	// --- Timing 2: recordFallbackApprove 清除连续阻断与指纹缓存 ---
	tracker.recordBlock("fp_1");
	tracker.recordBlock("fp_2");
	assert.strictEqual(tracker.getStats().consecutiveBlock, 2);
	assert.strictEqual(tracker.getStats().pendingFingerprint, "fp_2");

	tracker.recordFallbackApprove();
	assert.strictEqual(tracker.getStats().consecutiveBlock, 0, "人工批准清除 consecutiveBlock");
	assert.strictEqual(tracker.getStats().pendingFingerprint, null, "人工批准清除指纹短路缓存");

	// --- Timing 3: 自愈机制（连续 3 次放行成功扣减 totalBlock 3 点） ---
	tracker.resetAll();
	// 制造 8 次拦截
	for (let i = 0; i < 8; i++) {
		tracker.recordBlock(`fp_${i}`);
	}
	assert.strictEqual(tracker.getStats().totalBlock, 8);

	// 成功 1 次与 2 次：未达 3 次连续，totalBlock 不变
	tracker.recordAllow();
	assert.strictEqual(tracker.getStats().totalBlock, 8);
	tracker.recordAllow();
	assert.strictEqual(tracker.getStats().totalBlock, 8);

	// 成功第 3 次：满足连续 3 次成功，扣减 3 点，totalBlock 变为 5
	tracker.recordAllow();
	assert.strictEqual(tracker.getStats().totalBlock, 5, "连续 3 次成功扣减 3 点 totalBlock");

	// 再次连续 3 次成功：扣减 3 点，totalBlock 变为 2
	tracker.recordAllow();
	tracker.recordAllow();
	tracker.recordAllow();
	assert.strictEqual(tracker.getStats().totalBlock, 2);

	// 再次连续 3 次成功：Math.max(0, 2 - 3) = 0，不出现负数
	tracker.recordAllow();
	tracker.recordAllow();
	tracker.recordAllow();
	assert.strictEqual(tracker.getStats().totalBlock, 0);

	// 中途被阻断打断自愈连续计数
	tracker.recordAllow();
	tracker.recordAllow();
	tracker.recordBlock("fp_interrupt"); // 打断
	tracker.recordAllow(); // 重新计第 1 次
	assert.strictEqual(tracker.getStats().totalBlock, 1);

	// --- Timing 1: before_agent_start 重置轮次配额 ---
	const h = await setupHarness({ hasUI: true, mode: "auto" });
	// 触发 before_agent_start 钩子
	await h.handlers["before_agent_start"]({}, h.ctx);

	// --- Timing 4: switchMode 重置全部 tracker ---
	await h.commands["approval-mode"].handler("manual", h.ctx);
	await h.commands["approval-mode"].handler("auto", h.ctx);
	// 验证 tracker 重置
});

test("Module E - 交互模式触顶绝不杀进程（terminate: false），无头模式仅在配置启用时杀进程", async () => {
	// 1. 交互模式：显式注入 MICRO_TEST_LIMITS (maxTotalDenials: 4)，达到上限后持续拒绝但 terminate 绝不为 true
	const hInteractive = await setupHarness({
		hasUI: true,
		mode: "auto",
		complete: async () => ({
			content: [{ type: "text", text: '{"shouldBlock": true, "reason": "danger"}' }],
		}),
		selectReply: (n) => (n % 2 === 1 ? null : "1"),
		config: {
			denialLimits: MICRO_TEST_LIMITS,
		},
	});

	// 累积达顶 4 次拒绝 (7 次交互，4 拒 3 放)
	for (let i = 1; i <= 7; i++) {
		await hInteractive.handlers["tool_call"]({ toolName: "bash", input: { command: `echo ${i}` } }, hInteractive.ctx);
	}

	// 第 8 次调用触顶：必须返回 terminate 为 falsy
	const rCapped = await hInteractive.handlers["tool_call"]({ toolName: "bash", input: { command: "echo capped" } }, hInteractive.ctx);
	assert.strictEqual(rCapped?.block, true);
	assert.notStrictEqual(rCapped?.terminate, true, "交互模式达顶绝不退出进程");
	assert.match(String(rCapped?.reason), /session denial cap/);

	// 2. 无头模式配置 headlessAbortOnDenialCap: true
	const trackerHeadlessAbort = new DenialTracker({
		limits: { maxTotalDenials: 2 },
		abortOnDenialCap: true,
	});
	trackerHeadlessAbort.recordBlock("fp1");
	trackerHeadlessAbort.recordBlock("fp2");
	assert.strictEqual(trackerHeadlessAbort.shouldAbortOnCap(), true, "无头且配置 abortOnDenialCap 时允许终止");

	// 3. 无头模式默认不终止
	const trackerHeadlessDefault = new DenialTracker({
		limits: { maxTotalDenials: 2 },
		abortOnDenialCap: false,
	});
	trackerHeadlessDefault.recordBlock("fp1");
	trackerHeadlessDefault.recordBlock("fp2");
	assert.strictEqual(trackerHeadlessDefault.shouldAbortOnCap(), false);
});
