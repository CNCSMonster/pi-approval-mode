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

test("DenialTracker - 默认连续不可用阈值 = 3（设计基线 M11 锚定，）", () => {
	const tracker = new DenialTracker(); // 无显式配置 → 走默认值，防 2↔3 回归

	tracker.recordUnavailable();
	tracker.recordUnavailable();
	assert.equal(tracker.getStats().consecutiveUnavailable, 2);
	assert.equal(tracker.checkFallback("fp").shouldFallback, false, "第 2 次连续不可用不得熔断（默认阈值必须 > 2）");

	tracker.recordUnavailable();
	const check = tracker.checkFallback("fp");
	assert.equal(check.shouldFallback, true, "第 3 次连续不可用必须熔断（M11 默认 3）");
	assert.equal(check.kind, "consecutive_unavailable");
	assert.match(check.reasonText, /classifier unavailable x3/);
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

	const manualBash = DENIAL_MESSAGES.manualBashHeadless("git push");
	assert.match(manualBash, /\[Manual Mode\] Shell execution requires approval/i);

	const planEdit = DENIAL_MESSAGES.planModeToolDisabled("edit");
	assert.match(planEdit, /Plan mode is read-only: the "edit" tool is disabled/i);

	const planBash = DENIAL_MESSAGES.planModeCommandBlocked("rm -f file", "write action");
	assert.match(planBash, /Plan mode is read-only: non-read-only command blocked/i);
});

// -A：u 的语义是"分类器连续 N 次不可用"（M11），快路径放行没碰过分类器，无权治愈故障计数。
test("recordAllow 不重置 consecutiveUnavailable；仅 recordClassifierActive/resetAll 有权重置", () => {
	const tracker = new DenialTracker();

	tracker.recordUnavailable();
	tracker.recordUnavailable();
	assert.equal(tracker.getStats().consecutiveUnavailable, 2);

	// 放行只治拒绝侧（consecutiveBlock + 指纹），不得治愈不可用计数
	tracker.recordBlock("fp1");
	tracker.recordAllow();
	assert.equal(tracker.getStats().consecutiveBlock, 0, "拒绝侧连续计数仍由放行重置");
	assert.equal(tracker.getStats().pendingFingerprint, null, "指纹仍由放行消费");
	assert.equal(tracker.getStats().consecutiveUnavailable, 2, "快路径放行无权重置不可用计数");

	// 分类器成功响应仍是除 resetAll 外唯一可重置 u 的入口（0017 既有语义保持）
	tracker.recordClassifierActive();
	assert.equal(tracker.getStats().consecutiveUnavailable, 0);

	tracker.recordUnavailable();
	tracker.recordUnavailable();
	tracker.recordUnavailable();
	tracker.resetAll();
	assert.equal(tracker.getStats().consecutiveUnavailable, 0, "resetAll 仍可全清");
});

// -B-2：total_denial 达顶不再向模型承诺"unrelated safe work may continue"
// （无头语境被 loop 先手会话级熔断否决、交互语境达顶直接拒绝——文案必须说实话）。
test("total_denial 文案删除可绕行承诺，改为人解除指引", () => {
	const tracker = new DenialTracker({ limits: { maxTotalDenials: 1 } });
	tracker.recordBlock("fp1");

	const check = tracker.checkFallback("fp_new");
	assert.equal(check.kind, "total_denial");
	assert.match(check.reasonText, /Auto mode reached its session denial cap \(1\)/, "既有前缀锚点保持");
	assert.doesNotMatch(check.reasonText, /unrelated safe work may continue/i);
	assert.match(check.reasonText, /allow rule/, "告知人如何解除");

	assert.doesNotMatch(DENIAL_MESSAGES.totalDenial(20), /unrelated safe work may continue/i);
	assert.match(DENIAL_MESSAGES.totalDenial(20), /session denial cap/);

	// B-1：无头熔断文案明示"会话已熔断 + 需人工介入"，且无任何"转换策略/可继续"类误导
	const fused = DENIAL_MESSAGES.headlessCircuitFused("consecutive_denials", 3);
	assert.match(fused, /\[Circuit Breaker\]/);
	assert.match(fused, /circuit is open/);
	assert.match(fused, /Human intervention is required/);
	assert.doesNotMatch(fused, /转换策略|switch (your )?strategy|continue with unrelated/i);
});

// / ：双系统分账锚定——DenialTracker 族默认 3/3/50（提升总摩擦预算至 50）。
test("DenialTracker - 默认阈值锚定 3/3/50（双系统分账）", () => {
	const tracker = new DenialTracker();
	assert.deepStrictEqual(tracker.getLimits(), {
		maxConsecutiveBlock: 3,
		maxConsecutiveUnavailable: 3,
		maxTotalDenials: 50,
	});
});

// -A'：降级态人工批准 = 自愈触发器（Qwen Code recordFallbackApprove 同款语义）
test("DenialTracker - recordFallbackApprove 清两类连击计数（0034-A' 自愈）", () => {
	const tracker = new DenialTracker();
	// 制造降级态：3 次不可用触顶 + 若干连拦
	for (let i = 0; i < 3; i++) tracker.recordUnavailable();
	for (let i = 0; i < 2; i++) tracker.recordBlock();
	assert.strictEqual(tracker.getStats().consecutiveUnavailable, 3, "触顶前置条件");
	assert.strictEqual(tracker.getStats().consecutiveBlock, 2);

	tracker.recordFallbackApprove(); // 用户在降级弹窗上批准一次
	assert.strictEqual(tracker.getStats().consecutiveUnavailable, 0, "批准后不可用计数清零 → 恢复分类器");
	assert.strictEqual(tracker.getStats().consecutiveBlock, 0, "批准后连拦计数一并清零");

	// 恢复后若分类器仍故障：重新计数（同一恢复曲线，无永久锁死）
	tracker.recordUnavailable();
	assert.strictEqual(tracker.getStats().consecutiveUnavailable, 1, "失败重新计数");
	// 累计计数不因批准清零（total 只统计、不参与连击熔断）
	assert.ok(tracker.getStats().totalUnavailable >= 4, "totalUnavailable 不被批准重置");
});

test("DenialTracker - 快路径放行仍不清 unavailable（0027-A 防洗白不变，0034 未放宽）", () => {
	const tracker = new DenialTracker();
	tracker.recordUnavailable();
	tracker.recordAllow(); // 规则/快路径放行
	assert.strictEqual(tracker.getStats().consecutiveUnavailable, 1, "0027-A：快路径无权治愈故障计数");
});

test("DenialTracker - updateConfig 与 isTotalCapReached 及 DENIAL_MESSAGES 全分支", () => {
	const tracker = new DenialTracker();

	// updateConfig 增量更新与异常边界
	tracker.updateConfig({
		limits: {
			maxConsecutiveBlock: 5,
			maxConsecutiveUnavailable: 6,
			maxTotalDenials: 20,
		},
		abortOnDenialCap: true,
	});
	assert.deepEqual(tracker.getLimits(), {
		maxConsecutiveBlock: 5,
		maxConsecutiveUnavailable: 6,
		maxTotalDenials: 20,
	});
	assert.equal(tracker.shouldAbortOnCap(), true);

	// 非正数或缺省值不覆盖
	tracker.updateConfig({
		limits: {
			maxConsecutiveBlock: -1 as any,
			maxConsecutiveUnavailable: 0 as any,
		},
	});
	assert.equal(tracker.getLimits().maxConsecutiveBlock, 5);
	assert.equal(tracker.getLimits().maxConsecutiveUnavailable, 6);

	// isTotalCapReached
	assert.equal(tracker.isTotalCapReached(), false);
	for (let i = 0; i < 20; i++) {
		tracker.recordBlock(`test-${i}`);
	}
	assert.equal(tracker.isTotalCapReached(), true);

	// DENIAL_MESSAGES 各种模板生成覆盖
	assert.match(DENIAL_MESSAGES.singleUnavailable("1"), /could not classify this action \(1\)/);
	assert.match(DENIAL_MESSAGES.manualWriteHeadless("main.ts"), /File writes require approval/);
	assert.match(DENIAL_MESSAGES.userDenied("rm -rf"), /the user denied/);
	assert.match(DENIAL_MESSAGES.circuitBreaker("too many failures"), /fast-fail/);
	assert.match(DENIAL_MESSAGES.presetDeny("Deny(Bash)"), /Blocked by preset rule/);
	assert.match(DENIAL_MESSAGES.presetAskHeadless("Ask(Bash)"), /requires interactive confirmation/);
	assert.match(DENIAL_MESSAGES.planModeToolDisabled("edit"), /disabled/);
	assert.match(DENIAL_MESSAGES.planModeCommandBlocked("rm -f", "destructive"), /destructive/);
	assert.match(DENIAL_MESSAGES.autoProtectedPath("safety", ".env"), /target: \.env/);
	assert.match(DENIAL_MESSAGES.autoCommandBlocked("dangerous", "dd"), /dd/);
	assert.match(DENIAL_MESSAGES.autoReadBlocked("forbidden", "id_rsa"), /id_rsa/);
	assert.match(DENIAL_MESSAGES.autoEditReadHeadless("secret.txt"), /secret\.txt/);
	assert.match(DENIAL_MESSAGES.manualReadHeadless("secret.txt"), /secret\.txt/);
	assert.match(DENIAL_MESSAGES.autoEditHeadless("cargo build"), /cargo build/);
	assert.match(DENIAL_MESSAGES.autoEditProtectedPathHeadless("config.json"), /config\.json/);
	assert.match(DENIAL_MESSAGES.manualEditHeadless("foo.ts"), /foo\.ts/);
	assert.match(DENIAL_MESSAGES.manualBashHeadless("rm -rf /"), /rm -rf \//);
	assert.match(DENIAL_MESSAGES.heuristicFallback("rm -rf"), /deterministic/);
	assert.match(DENIAL_MESSAGES.classifierBlockedRetry(), /previously blocked/);
	assert.match(DENIAL_MESSAGES.consecutiveBlock("risk"), /consecutive denial limit/);
	assert.match(DENIAL_MESSAGES.consecutiveUnavailable(3), /x3/);
	assert.match(DENIAL_MESSAGES.totalDenial(50), /50/);
	assert.match(DENIAL_MESSAGES.headlessCircuitFused("loop", 5), /loop: 5/);
	assert.match(DENIAL_MESSAGES.classifierContentFilter("bash"), /content filter/);
	assert.match(DENIAL_MESSAGES.classifierUpstreamError("500", "bash"), /500/);
});
