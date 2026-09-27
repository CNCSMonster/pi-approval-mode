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

test("LoopDetector - 参数颠簸停滞 (Parameter Thrashing)", () => {
	const detector = new LoopDetector({ stagnationThreshold: 4 });

	// 连续在同一个工具上尝试不同参数
	detector.recordSuccess("bash", { command: "cat file1.txt" });
	detector.recordSuccess("bash", { command: "cat file2.txt" });
	detector.recordSuccess("bash", { command: "cat file3.txt" });

	// 第 4 次触顶停滞
	const res = detector.checkBeforeExecution("bash", { command: "cat file4.txt" });
	assert.equal(res.isLoop, true);
	assert.equal(res.loopType, "action_stagnation");
	assert.equal(res.streak, 4);
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
