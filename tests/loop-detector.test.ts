import test from "node:test";
import assert from "node:assert/strict";
import { LoopDetector } from "../extensions/loop-detector.ts";

test("LoopDetector - 连续完全相同的工具调用熔断", () => {
	const detector = new LoopDetector({ identicalThreshold: 3 });

	const call = { toolName: "bash", input: { command: "npm test" } };

	// 第 1 次
	let res = detector.checkBeforeExecution(call.toolName, call.input);
	assert.equal(res.isLoop, false);
	detector.recordSuccess(call.toolName, call.input);

	// 第 2 次
	res = detector.checkBeforeExecution(call.toolName, call.input);
	assert.equal(res.isLoop, false);
	detector.recordSuccess(call.toolName, call.input);

	// 第 3 次：触顶熔断
	res = detector.checkBeforeExecution(call.toolName, call.input);
	assert.equal(res.isLoop, true);
	assert.equal(res.loopType, "identical_call_loop");
	assert.equal(res.streak, 3);
});

test("LoopDetector - 连续被拒熔断 (Consecutive Denials)", () => {
	const detector = new LoopDetector({ denialThreshold: 3 });

	// 第 1 次被拒
	detector.recordDenial("bash", { command: "rm -rf /" });
	let res = detector.checkBeforeExecution("bash", { command: "rm -rf /home" });
	assert.equal(res.isLoop, false);

	// 第 2 次被拒
	detector.recordDenial("bash", { command: "rm -rf /home" });
	res = detector.checkBeforeExecution("edit", { path: "secret.txt" });
	assert.equal(res.isLoop, false);

	// 第 3 次被拒
	detector.recordDenial("edit", { path: "secret.txt" });
	// 第 4 次准备发起任何调用，立即熔断
	res = detector.checkBeforeExecution("bash", { command: "ls" });
	assert.equal(res.isLoop, true);
	assert.equal(res.loopType, "consecutive_denials");
	assert.equal(res.streak, 3);

	// 成功执行一次后，连续被拒计数清零
	detector.recordSuccess("bash", { command: "ls" });
	res = detector.checkBeforeExecution("bash", { command: "git status" });
	assert.equal(res.isLoop, false);
});

test("LoopDetector - 用法不同的连续调用不误判为停滞", () => {
	const detector = new LoopDetector({ stagnationThreshold: 4 });

	// 同一工具不同用法（不同文件）且都在推进 = 正常，不应熔断
	detector.recordSuccess("bash", { command: "cat file1.txt" });
	detector.recordSuccess("bash", { command: "cat file2.txt" });
	detector.recordSuccess("bash", { command: "cat file3.txt" });

	// 第 4 次仍是不同用法：不算停滞
	const res = detector.checkBeforeExecution("bash", { command: "cat file4.txt" });
	assert.equal(res.isLoop, false);
});

test("LoopDetector - 同一操作反复重试且无进展才触发停滞", () => {
	// 抬高 identical/denial 阈值，单独验证 action_stagnation 机制
	const detector = new LoopDetector({
		identicalThreshold: 100,
		denialThreshold: 100,
		stagnationThreshold: 4,
	});

	// 同一操作被反复拒绝（无进展）：第 3 次后，第 4 次触顶停滞
	for (let i = 0; i < 3; i++) {
		detector.recordDenial("bash", { command: "rm -rf /" });
	}
	const res = detector.checkBeforeExecution("bash", { command: "rm -rf /" });
	assert.equal(res.isLoop, true);
	assert.equal(res.loopType, "action_stagnation");
	assert.equal(res.streak, 4);
});

test("LoopDetector - 成功即清零，重复成功不算停滞", () => {
	// 抬高 identical/denial 阈值，单独看 action_stagnation 是否被成功清零
	const detector = new LoopDetector({
		identicalThreshold: 100,
		denialThreshold: 100,
		stagnationThreshold: 3,
	});

	// 连续成功重复同一操作：成功 = 有进展，停滞计数应清零
	detector.recordSuccess("bash", { command: "npm test" });
	detector.recordSuccess("bash", { command: "npm test" });
	detector.recordSuccess("bash", { command: "npm test" });

	const res = detector.checkBeforeExecution("bash", { command: "npm test" });
	assert.equal(res.isLoop, false);
});

test("LoopDetector - 支持动态从配置更新阈值偏好", () => {
	const detector = new LoopDetector(); // 默认 identicalThreshold 为 3

	// 更新为 2
	detector.updateThresholds({ identicalThreshold: 2, denialThreshold: 5 });

	const call = { toolName: "bash", input: { command: "git status" } };
	detector.recordSuccess(call.toolName, call.input);

	// 第 2 次即触顶
	const res = detector.checkBeforeExecution(call.toolName, call.input);
	assert.equal(res.isLoop, true);
	assert.equal(res.streak, 2);
});

test("LoopDetector - 预警文案随次数升级与硬上限熔断", () => {
	// identicalThreshold: 2, hardLimitMultiplier: 3 => hardLimit = 6
	const detector = new LoopDetector({
		identicalThreshold: 2,
		hardLimitMultiplier: 3,
	});

	const call = { toolName: "bash", input: { command: "pytest" } };
	detector.recordSuccess(call.toolName, call.input);

	// 第 2 次调用：首次触顶预警
	const res2 = detector.checkBeforeExecution(call.toolName, call.input);
	assert.equal(res2.isLoop, true);
	assert.equal(res2.isHardLimit, false);
	assert.equal(res2.streak, 2);
	assert.ok(res2.warningMessage?.includes("连续 2 次"));

	// 记录第 2 次成功
	detector.recordSuccess(call.toolName, call.input);

	// 第 3 次调用：升级为严重预警文案
	const res3 = detector.checkBeforeExecution(call.toolName, call.input);
	assert.equal(res3.isLoop, true);
	assert.equal(res3.isHardLimit, false);
	assert.equal(res3.streak, 3);
	assert.ok(res3.warningMessage?.includes("严重预警"));
	assert.ok(res3.warningMessage?.includes("连续第 3 次"));

	// 记录到第 5 次
	detector.recordSuccess(call.toolName, call.input); // 3
	detector.recordSuccess(call.toolName, call.input); // 4
	detector.recordSuccess(call.toolName, call.input); // 5

	// 第 6 次调用：达到硬上限 (2 * 3 = 6)，自动触发硬熔断
	const res6 = detector.checkBeforeExecution(call.toolName, call.input);
	assert.equal(res6.isLoop, true);
	assert.equal(res6.isHardLimit, true);
	assert.equal(res6.streak, 6);
	assert.ok(res6.warningMessage?.includes("死循环硬上限触发"));
	assert.ok(res6.warningMessage?.includes("强制自动熔断"));
});

