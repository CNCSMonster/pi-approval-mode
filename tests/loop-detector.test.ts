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

test("LoopDetector - 同一操作反复重试且无进展才触发停滞（满足可达性条件：identical>stagnation 且 denial>stagnation）", () => {
	// 停滞分支只在两道前置检查都不先撞线时可达：identicalThreshold(20) > stagnationThreshold(6)
	// 且 denialThreshold(20) > stagnationThreshold(6)。
	const detector = new LoopDetector({
		identicalThreshold: 20,
		denialThreshold: 20,
		stagnationThreshold: 6,
	});

	// 同一操作被反复拒绝（无进展）：第 6 次触顶停滞
	for (let i = 0; i < 5; i++) {
		detector.recordDenial("bash", { command: "rm -rf /" });
	}
	const res = detector.checkBeforeExecution("bash", { command: "rm -rf /" });
	assert.equal(res.isLoop, true);
	assert.equal(res.loopType, "action_stagnation");
	assert.equal(res.streak, 6);
});

test("LoopDetector - 停滞分支硬上限跟随 hardLimitMultiplier（ 拍板①，可达性条件：identical/denial 均 > 硬上限）", () => {
	// 取 headroom：硬上限 = stagnationThreshold(6) × hardLimitMultiplier(3) = 18，
	// 须 identicalThreshold(20) 与 denialThreshold(20) 都大于 18，检查 1/2 才不会抢在停滞硬熔断之前。
	const detector = new LoopDetector({
		identicalThreshold: 20,
		denialThreshold: 20,
		stagnationThreshold: 6,
		hardLimitMultiplier: 3,
	});

	const sig = { command: "rm -rf /" };
	let denials = 0;
	const advanceTo = (streak: number) => {
		while (denials < streak - 1) {
			detector.recordDenial("bash", sig);
			denials++;
		}
		return detector.checkBeforeExecution("bash", sig);
	};

	// 首次触顶（streak 6）：基础停滞提示
	const res6 = advanceTo(6);
	assert.equal(res6.loopType, "action_stagnation");
	assert.equal(res6.streak, 6);
	assert.equal(res6.isHardLimit, false);

	// 升级预警（streak 7）：文案告知硬上限为 6 × 3 = 18（旧实现写死 * 2 会算出 12）
	const res7 = advanceTo(7);
	assert.equal(res7.loopType, "action_stagnation");
	assert.ok(res7.warningMessage?.includes("达到 18 次将自动熔断"));

	// 第 12 次：若沿用旧的 * 2 乘数此处已是硬熔断，新语义下 12 < 18 仍只是严重预警
	const res12 = advanceTo(12);
	assert.equal(res12.loopType, "action_stagnation");
	assert.equal(res12.streak, 12);
	assert.equal(res12.isHardLimit, false);
	assert.ok(res12.warningMessage?.includes("严重预警"));

	// 第 18 次：达到新乘数硬上限，强制熔断
	const res18 = advanceTo(18);
	assert.equal(res18.loopType, "action_stagnation");
	assert.equal(res18.streak, 18);
	assert.equal(res18.isHardLimit, true);
	assert.ok(res18.warningMessage?.includes("停滞硬上限触发"));
	assert.ok(res18.warningMessage?.includes("超过安全硬上限 (18)"));
});

test("LoopDetector - 默认配置下连拒由 consecutive_denials / identical_call_loop 先手，action_stagnation 不触发（防改检查顺序）", () => {
	// 默认 identical=3、denial=3、stagnation=6 不满足可达性条件（两道前置都先撞线），
	// 因此停滞分支在默认配置下永不返回。若有人调整检查顺序，本测试必须报警。
	const sameSig = new LoopDetector(); // 默认 3/3/6
	for (let i = 0; i < 5; i++) {
		const res = sameSig.checkBeforeExecution("bash", { command: "rm -rf /" });
		if (res.isLoop) assert.notEqual(res.loopType, "action_stagnation");
		sameSig.recordDenial("bash", { command: "rm -rf /" });
	}
	// 同签名连拒到第 3 次由 identical_call_loop 先手
	const res = sameSig.checkBeforeExecution("bash", { command: "rm -rf /" });
	assert.equal(res.loopType, "identical_call_loop");

	// 变换签名的连拒：停滞计数不累计，由 consecutive_denials 在第 3 次先手
	const altSig = new LoopDetector();
	altSig.recordDenial("bash", { command: "a" });
	altSig.recordDenial("bash", { command: "b" });
	altSig.recordDenial("bash", { command: "c" });
	const altRes = altSig.checkBeforeExecution("edit", { path: "d" });
	assert.equal(altRes.isLoop, true);
	assert.equal(altRes.loopType, "consecutive_denials");
	assert.equal(altRes.streak, 3);
});

test("LoopDetector - 成功即清零，重复成功不算停滞（满足可达性条件：identical>stagnation 且 denial>stagnation）", () => {
	// 抬高 identical/denial 阈值以满足停滞分支可达性条件（20 > 3），单独看 action_stagnation 是否被成功清零
	const detector = new LoopDetector({
		identicalThreshold: 20,
		denialThreshold: 20,
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

test("LoopDetector - 预警文案随次数升级与硬上限熔断 ", () => {
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

