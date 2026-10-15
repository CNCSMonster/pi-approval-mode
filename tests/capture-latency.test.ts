import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ApprovalCaptureEngine,
	DEFAULT_CAPTURE_MAX_DISK_BYTES,
	type CaptureCallInput,
	type ResolvedCaptureSettings,
} from "../extensions/approval-capture.ts";

// 验收条款的主动验证：issue「对日常工具调用毫秒级性能零劣化」。
// 入口同步路径只做浅引用快照（无 I/O、无 stringify、无正则），重活全部在写队列协程。
// 本微基准度量 startCall + finish 的同步返回耗时（不含异步队列），上界取极宽松的 2ms/次，
// 既防性能回退红化，又不因测试机负载抖动误报。
function makeInput(): CaptureCallInput {
	return {
		toolName: "bash",
		rawArguments: { command: "echo hi" },
		rawBranchEntries: [],
		environment: {
			cwd: "/tmp",
			isProjectTrusted: true,
			approvalMode: "auto",
			registeredTools: [],
			environmentVars: {},
			denialTrackerStatus: { consecutiveBlocks: 0, consecutiveUnavailable: 0, totalDenials: 0 },
		},
		classifierConfig: {
			stage1ModelResolved: "a/b",
			stage2ModelResolved: "a/b",
			stage1Thinking: "off",
			stage2Thinking: "off",
			stage1TimeoutMs: 1,
			stage2TimeoutMs: 1,
		},
		policies: {},
	};
}

test("采集热路径微基准 - 入口同步路径远低于毫秒级（零劣化验收的主动验证）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-capture-latency-"));
	try {
		const settings: ResolvedCaptureSettings = {
			maxDiskBytes: DEFAULT_CAPTURE_MAX_DISK_BYTES,
			retentionDays: 30,
			scrubSecrets: true,
			retainScrubMap: false,
			syncWrite: false,
			captureSelf: false,
			excludeWorkspaces: [],
		};
		const engine = new ApprovalCaptureEngine({ agentDir: home, settings });

		// 预热（JIT 与首次分配不计入）
		for (let i = 0; i < 10; i++) {
			const handle = engine.startCall(makeInput());
			handle!.finishAllowed();
		}

		const N = 100;
		const started = performance.now();
		for (let i = 0; i < N; i++) {
			const handle = engine.startCall(makeInput());
			handle!.finishAllowed();
		}
		const elapsedMs = performance.now() - started;
		const perCallMs = elapsedMs / N;
		console.log(`[capture-latency] 入口同步路径平均 ${perCallMs.toFixed(4)} ms/次（N=${N}，含 startCall+finish）`);
		assert.ok(
			perCallMs < 2,
			`入口同步路径平均 ${perCallMs.toFixed(4)}ms/次 应远低于毫秒级阈值（2ms 为极宽松上界）`,
		);

		await engine.flush(); // 排空异步写队列（构建/脱敏/落盘），避免遗留任务干扰后续测试
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
