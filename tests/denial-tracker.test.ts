import test from "node:test";
import assert from "node:assert/strict";
import { DenialTracker, DENIAL_MESSAGES } from "../extensions/denial-tracker.ts";

test("DenialTracker - 基础状态转换与成功重置", () => {
	const tracker = new DenialTracker({
		limits: { maxConsecutiveBlock: 3, maxTotalDenials: 10 },
	});

	tracker.recordBlock("fp1");
	assert.equal(tracker.getStats().consecutiveBlock, 1);
	assert.equal(tracker.getStats().totalBlock, 1);

	tracker.recordBlock("fp2");
	assert.equal(tracker.getStats().consecutiveBlock, 2);
	assert.equal(tracker.getStats().totalBlock, 2);

	tracker.recordAllow();
	assert.equal(tracker.getStats().consecutiveBlock, 0);
	// totalBlock 属于任务级累计，成功执行不应重置
	assert.equal(tracker.getStats().totalBlock, 2);
});

test("DenialTracker - 连续拒绝熔断 (consecutive_block)", () => {
	const tracker = new DenialTracker({
		limits: { maxConsecutiveBlock: 3 },
	});

	tracker.recordBlock("fp1");
	tracker.recordBlock("fp2");
	assert.equal(tracker.checkFallback("fp_other").shouldFallback, false);

	tracker.recordBlock("fp3");
	const check = tracker.checkFallback("fp_other");
	assert.equal(check.shouldFallback, true);
	assert.equal(check.kind, "consecutive_block");
	assert.match(check.reasonText, /Auto mode reached its consecutive denial limit/);
});

test("DenialTracker - 分类器不可用与连续失败熔断 (consecutive_unavailable)", () => {
	const tracker = new DenialTracker({
		limits: { maxConsecutiveUnavailable: 2 },
	});

	tracker.recordUnavailable();
	assert.equal(tracker.getStats().consecutiveUnavailable, 1);
	assert.equal(tracker.checkFallback("fp").shouldFallback, false);

	tracker.recordUnavailable();
	assert.equal(tracker.getStats().consecutiveUnavailable, 2);

	const check = tracker.checkFallback("fp");
	assert.equal(check.shouldFallback, true);
	assert.equal(check.kind, "consecutive_unavailable");
	assert.match(check.reasonText, /classifier unavailable x2/);

	// 分类器成功调用后恢复
	tracker.recordClassifierActive();
	assert.equal(tracker.getStats().consecutiveUnavailable, 0);
	assert.equal(tracker.checkFallback("fp").shouldFallback, false);
});

test("DenialTracker - 任务级累计拒绝上限与 terminate: true (total_denial)", () => {
	const tracker = new DenialTracker({
		limits: { maxTotalDenials: 5, maxConsecutiveBlock: 10 },
		abortOnDenialCap: true,
	});

	for (let i = 0; i < 4; i++) {
		tracker.recordBlock(`fp_${i}`);
		tracker.recordAllow(); // 重置 consecutiveBlock
	}

	assert.equal(tracker.getStats().totalBlock, 4);
	assert.equal(tracker.checkFallback("fp_new").shouldFallback, false);

	tracker.recordBlock("fp_4");
	assert.equal(tracker.getStats().totalBlock, 5);

	const check = tracker.checkFallback("fp_new");
	assert.equal(check.shouldFallback, true);
	assert.equal(check.kind, "total_denial");
	assert.match(check.reasonText, /Auto mode reached its session denial cap \(5\)/);
	assert.equal(tracker.shouldAbortOnCap(), true);
});

test("DenialTracker - 相同动作指纹短路拦截 (pendingManualRetryFingerprint)", () => {
	const tracker = new DenialTracker();
	const fpBash = DenialTracker.createFingerprint("bash", { command: "rm -rf /tmp/foo" });
	const fpOther = DenialTracker.createFingerprint("bash", { command: "ls" });

	tracker.recordBlock(fpBash);

	// 相同的未决指纹直接短路阻断
	const checkSame = tracker.checkFallback(fpBash);
	assert.equal(checkSame.shouldFallback, true);
	assert.equal(checkSame.kind, "classifier_blocked_retry");
	assert.match(checkSame.reasonText, /Auto mode previously blocked this exact action/);

	// 不同的指纹不被拦截
	const checkOther = tracker.checkFallback(fpOther);
	assert.equal(checkOther.shouldFallback, false);

	// 人工审批消费指纹后短路解除
	tracker.consumePendingFingerprint();
	assert.equal(tracker.checkFallback(fpBash).shouldFallback, false);
});

test("DENIAL_MESSAGES - 英文文案标准化与全场景覆盖", () => {
	// 验证所有阻断消息均符合 Qwen Code 英文标准，并携带明确指示
	const presetAsk = DENIAL_MESSAGES.presetAskHeadless("Ask(Bash)");
	assert.match(presetAsk, /\[Permission: ask\] Rule Ask\(Bash\) requires interactive confirmation/);
	assert.match(presetAsk, /Continue with unrelated safe work or report the blocker to the user/);

	const autoProtected = DENIAL_MESSAGES.autoProtectedPath("Modifies config", ".pi/config.json");
	assert.match(autoProtected, /\[Auto Mode\] Protected-path write blocked/i);

	const autoEdit = DENIAL_MESSAGES.autoEditHeadless("cargo build");
	assert.match(autoEdit, /\[Auto-edit Mode\] Shell execution requires approval/i);

	const defaultBash = DENIAL_MESSAGES.defaultBashHeadless("git push");
	assert.match(defaultBash, /\[Default Mode\] Shell execution requires approval/i);

	const planEdit = DENIAL_MESSAGES.planModeToolDisabled("edit");
	assert.match(planEdit, /Plan mode is read-only: the "edit" tool is disabled/i);

	const planBash = DENIAL_MESSAGES.planModeCommandBlocked("rm -f file", "write action");
	assert.match(planBash, /Plan mode is read-only: non-read-only command blocked/i);
});
