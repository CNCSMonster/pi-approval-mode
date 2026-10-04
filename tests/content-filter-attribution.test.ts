import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import approvalModeExtension from "../extensions/approval-mode.ts";

// 环境隔离：HOME / USERPROFILE 重定向到 mkdtemp，绝不写真实 ~/.pi
const sandboxHome = mkdtempSync(join(tmpdir(), "pi-issue-0034-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;

interface Harness {
	handlers: Record<string, any>;
	dialogs: string[];
	notices: string[];
	ctx: any;
	calls: () => number;
	setQueue: (q: Array<"throw" | "allow" | "filter" | "neterr">) => void;
}

// complete() 可编程：throw（异常）/ allow（正常判决）/ filter（上游内容过滤拒绝）/ neterr（上游其他错误）
async function setup(opts: { hasUI: boolean; selectQueue?: Array<string | null> }): Promise<Harness> {
	const handlers: Record<string, any> = {};
	const pi = {
		registerFlag: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		getActiveTools: () => ["bash", "edit"],
		setActiveTools: () => {},
		on: (event: string, handler: Function) => { handlers[event] = handler; },
		appendEntry: () => {},
		getFlag: (name: string) => (name === "approval-mode" ? "auto" : undefined),
	};
	approvalModeExtension(pi as any);

	const ctxModel = { provider: "ctx", id: "main" };
	let queue: Array<"throw" | "allow" | "filter" | "neterr"> = [];
	let calls = 0;
	const registry = {
		models: [ctxModel],
		find: () => null,
		getAll: () => [ctxModel] as any[],
		hasConfiguredAuth: () => true,
		complete: async () => {
			calls++;
			const act = queue.shift();
			if (act === "throw") throw new Error("model timeout");
			if (act === "filter")
				return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter", content: [] };
			if (act === "neterr")
				return { stopReason: "error", errorMessage: "Provider finish_reason: network_error", content: [] };
			return { content: [{ type: "text", text: act === "allow" ? '{"shouldBlock": false}' : '{"shouldBlock": true}' }] };
		},
	};

	const dialogs: string[] = [];
	const notices: string[] = [];
	const ctx: any = {
		modelRegistry: registry,
		model: ctxModel,
		hasUI: opts.hasUI,
		ui: {
			notify: (m: string) => notices.push(m),
			select: async (body: string) => {
				dialogs.push(body);
				return opts.selectQueue?.shift() ?? null; // 队列耗尽 = 拒绝（默认项）
			},
			theme: { fg: (_c: string, t: string) => t },
			setStatus: () => {},
		},
		cwd: "/test",
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};

	await handlers["session_start"]({ reason: "start" }, ctx);
	return { handlers, dialogs, notices, ctx, calls: () => calls, setQueue: (q) => { queue = q; } };
}

// 命令取 HIGH_RISK_PATTERNS 命中项（sudo），确保走分类器分支且启发式兜底同样判危险
const cmd = (n: number) => `sudo rm -rf /tmp/issue-0034-${n}`;

// ① 上游 content_filter → 分型归因（非 JSON 解析失败）+ 工具名可见
test("content_filter 归因：上游过滤、非审批判定、含工具名、不误报 parse_fail", async () => {
	const h = await setup({ hasUI: false });
	h.setQueue(["filter", "filter"]); // stage1、stage2 均被上游过滤
	const res = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(1) } }, h.ctx);
	assert.strictEqual(res?.block, true, "fail-closed 必须拦截");
	const reason = String(res?.reason);
	assert.match(reason, /content filter/i, "须明示上游内容过滤");
	assert.match(reason, /NOT a verdict/i, "须明示这不是审批判定结果");
	assert.match(reason, /bash/, "须带被阻止的工具名（回答'什么被阻止'）");
	assert.match(reason, /approving once restores/i, "须告知自愈方式");
	assert.doesNotMatch(reason, /stage2_json_parse_fail/, "绝不能误报为 JSON 解析失败");
	assert.doesNotMatch(reason, /JSON/i, "绝不能出现 JSON 字样误导");
});

// ② 上游其他错误 → 通用归因带错误码（优雅退化，仍非 parse_fail）
test("上游其他错误归因：带 finish_reason 码、非 parse_fail、优雅退化", async () => {
	const h = await setup({ hasUI: false });
	h.setQueue(["neterr", "neterr"]);
	const res = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(2) } }, h.ctx);
	assert.strictEqual(res?.block, true, "fail-closed 必须拦截");
	const reason = String(res?.reason);
	assert.match(reason, /network_error/, "须带上游错误码");
	assert.match(reason, /NOT a verdict/i, "须明示这不是审批判定结果");
	assert.doesNotMatch(reason, /stage2_json_parse_fail/, "绝不能误报为 JSON 解析失败");
});

// ③ A' 自愈闭环：熔断降级弹窗（明示状态）→ 人工批准一次 → 计数清零 → 分类器恢复
test("熔断降级弹窗明示状态，人工批准一次即恢复分类器", async () => {
	// selectQueue 前 3 项 null：失败弹窗全部"拒绝"（拒绝不清计数）→ consecutiveUnavailable 累积触顶
	// 第 4 项 "1"（allow_once）：降级态批准 → recordFallbackApprove 自愈
	const h = await setup({ hasUI: true, selectQueue: [null, null, null, "1"] });

	// 连续 3 次两阶段失败 → consecutiveUnavailable=3 触顶熔断（默认阈值 M11=3）
	for (let i = 0; i < 3; i++) {
		h.setQueue(["throw", "throw"]);
		await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(100 + i) } }, h.ctx);
	}

	// 熔断后：不再调分类器（complete 不被消费），走启发式规则 → sudo 危险 → 弹人工；
	// 弹窗必须明示"降级为规则研判 + 批准一次恢复分类器"
	h.setQueue([]);
	h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(110) } }, h.ctx);
	await new Promise((r) => setTimeout(r, 50)); // 等待异步弹窗分支完成
	const dialog = h.dialogs.find((d) => d.includes("降级为规则研判"));
	assert.ok(dialog, `降级弹窗须明示规则研判状态，实际弹窗: ${JSON.stringify(h.dialogs)}`);
	assert.match(dialog!, /批准一次即恢复/, "弹窗须告知自愈方式（批准一次恢复分类器）");

	// select 第4项 "1"（allow_once）→ handleOutcome approve + tripped → recordFallbackApprove 清零
	// 恢复验证：后续调用分类器重新介入（complete 被消费 = 走分类器而非纯启发式）
	const callsBefore = h.calls();
	h.setQueue(["allow"]);
	const res5 = await h.handlers["tool_call"]({ toolName: "bash", input: { command: cmd(120) } }, h.ctx);
	assert.strictEqual(res5, undefined, "恢复后分类器放行");
	assert.ok(h.calls() > callsBefore, "批准后分类器必须重新参与判定（计数已清零，脱离熔断态）");
});
