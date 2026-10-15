/**
 * 审批采集引擎（Approval Capture Engine）
 *
 * 方案依据：业务场景全量输入采集管道（两段式事件）——
 * 1. 事件 A（tool_call_captured）在决策漏斗入口无条件写入「投影之前的物理事实」：
 *    原始工具调用（未投影、字段级有界截断）、原始会话分支条目（最近 40 条 message 的无损视图）、
 *    物理执行环境、分类器运行配置、FS 解析 Oracle 快照、双层策略的内容寻址引用；
 * 2. 事件 B（human_outcome_recorded）在终局落地时写入（弹窗动作 / 短路阻断 / 免审放行 / 启动对账），
 *    携带终局标签（outcome 词汇表）、决策者归因、规则溯源，以及入口时不可知的决策轨迹
 *    （matchedRule / pipelinePath / shortCircuit / derivedSnapshot / 熔断状态）——
 *    派生字段在物理上随终局记录一并落盘（写入时机即上述两个事件的写入点），两者以 callId 对账构成完整样本；
 * 3. 存储治理：per-process 单文件 + 写入队列串行化、CAS 策略内容寻址（scrub 后落盘）、
 *    全目录统一配额与引用清扫、TTL、0700/0600 权限；
 * 4. 启动对账：以「进程死亡 + 陈旧 24h」双门槛补写 ORPHANED（幂等：任意事件 B 即终态，防"死而复生"）；
 * 5. 同步路径零开销：入口仅做浅引用快照，深拷贝 / scrub / 截断 / 序列化 / 写盘全部在写队列内完成。
 *
 * 本模块不依赖 pi 运行时：全部环境由调用方注入（agentDir / settings / now / pid / uuid），可单测。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, chmodSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { Buffer } from "node:buffer";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { MAX_TRANSCRIPT_MESSAGES, resolvePathForProjection } from "./classifier-projection.ts";
import { globToRegex } from "./permission-engine.ts";
import { SCRUB_FIELD_SCAN_CAP_BYTES, scrubJsonTree, scrubText, truncateToBytes } from "./scrub.ts";
import { logClassifierInfo, logClassifierWarn } from "./logger.ts";

// ==========================================
// 常量
// ==========================================

export const CAPTURE_DIR_NAME = "approval-captures";
export const CAPTURE_SCRUB_MAP_DIR_NAME = "approval-scrub-maps";
export const CAPTURE_POLICY_DIR_NAME = "policies";
export const DEFAULT_CAPTURE_MAX_DISK_BYTES = 50 * 1024 * 1024;
export const DEFAULT_CAPTURE_RETENTION_DAYS = 30;
export const CAPTURE_QUEUE_MAX_DEPTH = 256;
export const CAPTURE_FIELD_CAP_BYTES = SCRUB_FIELD_SCAN_CAP_BYTES;
export const CAPTURE_EVENT_BRANCH_BUDGET_BYTES = 200 * 1024;
export const CAPTURE_EVENT_CPU_BUDGET_MS = 5;
export const CAPTURE_ORPHAN_STALE_MS = 24 * 60 * 60 * 1000;

// ==========================================
// 配置解析（单向开启原则）
// ==========================================

export interface CaptureDatasetConfig {
	enabled?: boolean;
	maxDiskBytes?: number;
	retentionDays?: number;
	scrubSecrets?: boolean;
	retainScrubMap?: boolean;
	excludeWorkspaces?: string[];
	syncWrite?: boolean;
	captureSelf?: boolean;
}

export interface ResolvedCaptureSettings {
	maxDiskBytes: number;
	retentionDays: number;
	scrubSecrets: boolean;
	retainScrubMap: boolean;
	syncWrite: boolean;
	captureSelf: boolean;
	excludeWorkspaces: string[];
}

/**
 * 解析采集设置（单向开启原则）：
 * - 只能由**全局配置或环境变量**开启：全局显式 enabled 优先；未显式时 env `PI_APPROVAL_MODE_CAPTURE=1` 单向开启；
 *   env 其他值一律无效（禁止经 env 反向关闭用户的配置意图）；
 * - 项目级配置永远不得开启采集，只能收紧：enabled→false、配额/保留期只能调小、排除名单只能追加；
 * - `scrubSecrets: false`、`retainScrubMap`、`syncWrite`、`captureSelf` 仅允许全局配置显式设置；
 * - 未受信任工作区强制禁采；`excludeWorkspaces` 命中即禁采。
 * 返回 null 表示禁用。
 */
export function resolveCaptureSettings(input: {
	globalConfig?: CaptureDatasetConfig;
	projectConfig?: CaptureDatasetConfig;
	envFlag?: string;
	isProjectTrusted: boolean;
	cwd?: string;
}): ResolvedCaptureSettings | null {
	try {
		// 单向开启
		let enabled: boolean;
		if (typeof input.globalConfig?.enabled === "boolean") {
			enabled = input.globalConfig.enabled;
		} else {
			enabled = input.envFlag === "1";
		}
		if (input.projectConfig?.enabled === false) enabled = false; // 项目级只能收紧
		if (!input.isProjectTrusted) enabled = false; // 未受信任强制禁采（双保险）
		if (!enabled) return null;

		const tighterNumber = (globalValue: unknown, projectValue: unknown, fallback: number): number => {
			const pick = (v: unknown): number | undefined =>
				typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
			const base = pick(globalValue) ?? fallback;
			const tightened = pick(projectValue);
			return tightened !== undefined ? Math.min(base, tightened) : base;
		};

		const excludeWorkspaces = [
			...(Array.isArray(input.globalConfig?.excludeWorkspaces) ? input.globalConfig.excludeWorkspaces : []),
			...(Array.isArray(input.projectConfig?.excludeWorkspaces) ? input.projectConfig.excludeWorkspaces : []),
		].filter((s): s is string => typeof s === "string" && s.trim().length > 0);

		if (input.cwd && excludeWorkspaces.some((pattern) => matchWorkspacePattern(pattern, input.cwd as string))) {
			return null;
		}

		return {
			maxDiskBytes: tighterNumber(input.globalConfig?.maxDiskBytes, input.projectConfig?.maxDiskBytes, DEFAULT_CAPTURE_MAX_DISK_BYTES),
			retentionDays: tighterNumber(input.globalConfig?.retentionDays, input.projectConfig?.retentionDays, DEFAULT_CAPTURE_RETENTION_DAYS),
			// scrubSecrets=false 仅允许全局显式设置（项目级设 false 无效，防放松）
			scrubSecrets: input.globalConfig?.scrubSecrets === false ? false : true,
			retainScrubMap: input.globalConfig?.retainScrubMap === true,
			syncWrite: input.globalConfig?.syncWrite === true,
			captureSelf: input.globalConfig?.captureSelf === true,
			excludeWorkspaces,
		};
	} catch {
		return null; // 解析异常一律按禁用处理（安全方向）
	}
}

function matchWorkspacePattern(pattern: string, cwd: string): boolean {
	try {
		const regex = globToRegex(pattern.replace(/\\/g, "/"));
		const normalized = cwd.replace(/\\/g, "/");
		return regex.test(normalized) || regex.test(`${normalized}/`);
	} catch {
		return false;
	}
}

// ==========================================
// 事件标签词汇表（终局分类学）
// ==========================================

export type CaptureOutcome =
	| "SYSTEM_AUTO_DENIED"
	| "RULE_ALLOWED"
	| "CLASSIFIER_ALLOWED"
	| "FALLBACK_ALLOWED"
	| "SYSTEM_ALLOWED"
	| "APPROVED_ONCE"
	| "ALLOWED_SESSION"
	| "ALLOWED_PROJECT"
	| "ALLOWED_USER"
	| "REJECTED"
	| "REJECTED_AND_ABORT"
	| "ORPHANED";

export type CaptureDecisionMaker = "human" | "classifier" | "heuristic" | "rule" | "system";

export type CaptureDenialReason = "rule_deny" | "loop_circuit" | "headless_cap" | "readonly_sandbox";

export type CaptureRuleLayer = "user" | "project" | "session";

export type CaptureHumanAction = "allow_once" | "allow_session" | "allow_project" | "allow_user" | "block" | "block_and_abort";

export interface CaptureLoopStatus {
	isLoop: boolean;
	isHardLimit: boolean;
	loopType?: string;
	streak: number;
}

export interface CaptureRuleDecisionNote {
	decision: "allow" | "ask" | "deny" | "default";
	matchedRule?: string;
	matchedLayer?: CaptureRuleLayer;
}

export interface CaptureClassifierNote {
	stage: "fast" | "thinking" | "fallback";
	shouldBlock: boolean;
	reason?: string;
	summary?: string;
	outage?: boolean;
}

export interface CaptureCallInput {
	toolName: string;
	rawArguments: Record<string, unknown>;
	rawBranchEntries: unknown[];
	environment: {
		cwd: string;
		isProjectTrusted: boolean;
		approvalMode: string;
		registeredTools: string[];
		environmentVars: Record<string, string>;
		denialTrackerStatus: { consecutiveBlocks: number; consecutiveUnavailable: number; totalDenials: number };
	};
	classifierConfig: {
		stage1ModelResolved: string;
		stage2ModelResolved: string;
		stage1Thinking: string;
		stage2Thinking: string;
		stage1TimeoutMs: number;
		stage2TimeoutMs: number;
	};
	policies: {
		globalPolicyText?: string;
		projectPolicyText?: string;
		globalPolicyTruncated?: boolean;
		projectPolicyTruncated?: boolean;
	};
}

export interface CaptureCallHandle {
	readonly callId: string;
	noteLoopResult(result: CaptureLoopStatus): void;
	noteRuleDecision(note: CaptureRuleDecisionNote): void;
	noteClassifier(note: CaptureClassifierNote): void;
	noteDialogShown(): void;
	finishBlocked(): void;
	finishAllowed(): void;
	finishHuman(action: CaptureHumanAction, dslRule: string): void;
}

export interface CaptureMaintenanceSummary {
	evictedByTtl: number;
	evictedByQuota: number;
	sweptPolicies: number;
	orphansWritten: number;
}

export interface CaptureEngineStats {
	droppedQueue: number;
	selfCaptureDropped: number;
	scrubBudgetExceeded: number;
	writes: number;
	writeErrors: number;
	parseErrors: number;
}

interface PendingCall {
	callId: string;
	startedAt: number;
	seq: number;
	input: CaptureCallInput;
	selfCapture: boolean;
	dialogShown: boolean;
	loop?: CaptureLoopStatus;
	rule?: CaptureRuleDecisionNote;
	classifier?: CaptureClassifierNote;
	finished: boolean;
	aDropped: boolean;
}

interface FinishSpec {
	outcome: CaptureOutcome;
	decisionMaker: CaptureDecisionMaker;
	denialReason?: CaptureDenialReason;
	ruleProvenance?: { scope: CaptureRuleLayer; persistedRuleText?: string };
}

const PATH_TOOLS = new Set([
	"read",
	"read_file",
	"write",
	"write_file",
	"edit",
	"notebook_edit",
	"grep",
	"grep_search",
	"find",
	"ls",
	"list_directory",
	"glob",
]);

// ==========================================
// 采集引擎
// ==========================================

export class ApprovalCaptureEngine {
	readonly captureDir: string;
	private readonly policyDir: string;
	private readonly settings: ResolvedCaptureSettings;
	private readonly pid: number;
	private readonly now: () => number;
	private readonly uuid: () => string;
	private seqCounter = 0;
	private targetFile: string | null = null;
	private queueTail: Promise<void> = Promise.resolve();
	private queueDepth = 0;
	private readonly counters: CaptureEngineStats = {
		droppedQueue: 0,
		selfCaptureDropped: 0,
		scrubBudgetExceeded: 0,
		writes: 0,
		writeErrors: 0,
		parseErrors: 0,
	};

	constructor(opts: { agentDir: string; settings: ResolvedCaptureSettings; pid?: number; now?: () => number; uuid?: () => string }) {
		this.captureDir = join(opts.agentDir, CAPTURE_DIR_NAME);
		this.policyDir = join(this.captureDir, CAPTURE_POLICY_DIR_NAME);
		this.settings = opts.settings;
		this.pid = opts.pid ?? process.pid;
		this.now = opts.now ?? (() => Date.now());
		this.uuid = opts.uuid ?? randomUUID;
		if (!this.settings.scrubSecrets) {
			logClassifierWarn("[ApprovalCapture] scrubSecrets=false（仅限全局显式设置）：采集落盘将不执行凭据脱敏，请确认取证/审计授权。");
		}
	}

	get stats(): CaptureEngineStats {
		return { ...this.counters };
	}

	/** 事件 A：在决策漏斗入口无条件写入（自污染调用默认整条丢弃；关闭态返回 null）。 */
	startCall(input: CaptureCallInput): CaptureCallHandle | null {
		try {
			const selfCapture = this.isSelfCapture(input.toolName, input.rawArguments);
			if (selfCapture && !this.settings.captureSelf) {
				this.counters.selfCaptureDropped++;
				return null;
			}
			const pending: PendingCall = {
				callId: this.uuid(),
				startedAt: this.now(),
				seq: ++this.seqCounter,
				input,
				selfCapture,
				dialogShown: false,
				finished: false,
				aDropped: false,
			};
			const accepted = this.commitRecord(() => this.buildEventA(pending));
			if (!accepted) pending.aDropped = true;
			return this.makeHandle(pending);
		} catch (err) {
			logClassifierWarn(`[ApprovalCapture] 采集入口异常（已跳过本次采集）: ${String(err)}`);
			return null;
		}
	}

	/** 启动治理：TTL → 配额淘汰 → CAS 引用清扫 → 孤儿对账（幂等）。 */
	async startupMaintenance(): Promise<CaptureMaintenanceSummary> {
		const summary: CaptureMaintenanceSummary = { evictedByTtl: 0, evictedByQuota: 0, sweptPolicies: 0, orphansWritten: 0 };
		try {
			if (this.settings.retainScrubMap) {
				logClassifierWarn("[ApprovalCapture] retainScrubMap=true 已配置：原文映射表落盘尚未启用（取证回溯工具交付前不落盘原文映射，隐私优先）。");
			}
			this.ensureDir();
			const nowMs = this.now();
			const ttlMs = this.settings.retentionDays * 24 * 60 * 60 * 1000;

			// 1) TTL：过期 JSONL 删除
			let files = this.listJsonlFiles();
			for (const file of files) {
				if (nowMs - file.mtimeMs > ttlMs) {
					rmSync(file.path, { force: true });
					summary.evictedByTtl++;
				}
			}

			// 2) 配额：JSONL 与 policies/ 合计超出上限时，按时间戳淘汰最早 JSONL（当前进程在写文件除外）
			files = this.listJsonlFiles();
			const totalBytes = (): number =>
				files.reduce((acc, f) => acc + f.size, 0) + this.policyDirTotalBytes();
			const victims = files
				.filter((f) => f.path !== this.targetFile)
				.sort((a, b) => a.mtimeMs - b.mtimeMs);
			let victimIndex = 0;
			while (totalBytes() > this.settings.maxDiskBytes && victimIndex < victims.length) {
				rmSync(victims[victimIndex].path, { force: true });
				files = files.filter((f) => f.path !== victims[victimIndex].path);
				victimIndex++;
				summary.evictedByQuota++;
			}

			// 3) CAS 引用清扫：留存 JSONL 引用集合之外的一律删除（杜绝引用悬空与无界增长）
			const referenced = this.collectReferencedPolicyHashes(files.map((f) => f.path));
			for (const policy of this.listPolicyFiles()) {
				const hash = basename(policy.name, ".md");
				if (!referenced.has(hash)) {
					rmSync(policy.path, { force: true });
					summary.sweptPolicies++;
				}
			}

			// 4) 孤儿对账（双门槛 + 幂等）
			summary.orphansWritten = await this.reconcileOrphans(files.map((f) => f.path));
			await this.flush();
			logClassifierInfo(
				`[ApprovalCapture] 启动治理完成：TTL 清理 ${summary.evictedByTtl}、配额淘汰 ${summary.evictedByQuota}、CAS 清扫 ${summary.sweptPolicies}、孤儿补写 ${summary.orphansWritten}`,
			);
		} catch (err) {
			logClassifierWarn(`[ApprovalCapture] 启动治理任务异常: ${String(err)}`);
		}
		return summary;
	}

	/** 等待写队列排空（测试与收尾用）。 */
	async flush(): Promise<void> {
		await this.queueTail;
	}

	// ==========================================
	// 事件 A 构建
	// ==========================================

	private buildEventA(pending: PendingCall): Record<string, unknown> {
		const input = pending.input;
		const argsCapped = this.capRecordFields(input.rawArguments);
		const payloadByteSize = safeJsonByteSize(input.rawArguments);
		const branch = this.buildBranchEntries(input.rawBranchEntries);
		const oracle = this.buildFsOracle(input.toolName, input.rawArguments, input.environment.cwd);
		const policies = this.buildPolicies(input.policies);
		return {
			eventType: "tool_call_captured",
			callId: pending.callId,
			timestamp: pending.startedAt,
			isoTime: new Date(pending.startedAt).toISOString(),
			seq: pending.seq,
			rawToolCall: {
				toolName: input.toolName,
				rawArguments: argsCapped.value,
				payloadByteSize,
				...(argsCapped.truncated ? { truncatedForStorage: true } : {}),
			},
			rawBranchEntries: branch.entries,
			...(branch.trimmed ? { branchEntriesTrimmed: true } : {}),
			environment: { ...input.environment },
			classifierConfig: { ...input.classifierConfig },
			...(oracle.oracle ? { fsResolutionOracle: oracle.oracle } : {}),
			...(oracle.missing ? { fsOracleMissing: true } : {}),
			policies,
			...(pending.selfCapture ? { selfCapture: true } : {}),
		};
	}

	private capRecordFields(args: Record<string, unknown>): { value: Record<string, unknown>; truncated: boolean } {
		const out: Record<string, unknown> = {};
		let truncated = false;
		for (const [key, value] of Object.entries(args ?? {})) {
			const capped = capSingleField(value);
			out[key] = capped.value;
			truncated = truncated || capped.truncated;
		}
		return { value: out, truncated };
	}

	private buildBranchEntries(rawEntries: unknown[]): { entries: Array<Record<string, unknown>>; trimmed: boolean } {
		const messages: Array<Record<string, any>> = [];
		for (const entry of rawEntries ?? []) {
			const e = entry as Record<string, any>;
			if (!e || e.type !== "message" || !e.message) continue;
			const role = e.message.role;
			if (role !== "user" && role !== "assistant") continue;
			messages.push(e);
		}
		const window = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
		const entries = window.map((e) => {
			const cappedContent = capSingleField(e.message.content);
			const ts = typeof e.message.timestamp === "number" ? e.message.timestamp : typeof e.timestamp === "number" ? e.timestamp : undefined;
			return {
				type: "message",
				role: e.message.role,
				content: cappedContent.value,
				...(ts !== undefined ? { timestamp: ts } : {}),
			};
		});
		let trimmed = false;
		while (entries.length > 1) {
			const total = safeJsonByteSize(entries);
			if (total <= CAPTURE_EVENT_BRANCH_BUDGET_BYTES) break;
			entries.shift();
			trimmed = true;
		}
		return { entries, trimmed };
	}

	private buildFsOracle(toolName: string, rawArguments: Record<string, unknown>, cwd: string): { oracle?: Record<string, unknown>; missing: boolean } {
		if (!PATH_TOOLS.has(toolName)) return { missing: false };
		const target = ["path", "file_path", "target_file"]
			.map((key) => rawArguments?.[key])
			.find((v): v is string => typeof v === "string" && v.trim().length > 0);
		if (!target) return { missing: true };
		try {
			const resolved = resolvePathForProjection(target, cwd) as {
				resolved_path?: string;
				resolved_from?: "direct" | "ancestor" | "lexical";
				dangling_symlink?: boolean;
				resolution_failed?: boolean;
			};
			return {
				oracle: {
					targetPath: target,
					...(resolved.resolved_path !== undefined ? { resolvedPath: resolved.resolved_path } : {}),
					...(resolved.dangling_symlink === true ? { danglingSymlink: true } : {}),
					...(resolved.resolution_failed === true ? { resolutionFailed: true } : {}),
					...(resolved.resolved_from !== undefined ? { resolvedFrom: resolved.resolved_from } : {}),
				},
				missing: false,
			};
		} catch {
			return { oracle: { targetPath: target, resolutionFailed: true }, missing: false };
		}
	}

	private buildPolicies(policies: CaptureCallInput["policies"]): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		const handlePolicy = (text: unknown, label: "global" | "project"): void => {
			if (typeof text !== "string" || text.length === 0) return;
			const scrubbed = this.settings.scrubSecrets ? scrubText(text).text : text;
			const hash = sha256Hex(scrubbed);
			this.ensurePolicyCas(hash, scrubbed);
			out[`${label}PolicyHash`] = hash;
		};
		handlePolicy(policies?.globalPolicyText, "global");
		handlePolicy(policies?.projectPolicyText, "project");
		if (policies?.globalPolicyTruncated) out.globalPolicyTruncated = true;
		if (policies?.projectPolicyTruncated) out.projectPolicyTruncated = true;
		return out;
	}

	// ==========================================
	// 事件 B 构建与终局归因
	// ==========================================

	private makeHandle(pending: PendingCall): CaptureCallHandle {
		return {
			callId: pending.callId,
			noteLoopResult: (result) => {
				try {
					pending.loop = {
						isLoop: result?.isLoop === true,
						isHardLimit: result?.isHardLimit === true,
						loopType: result?.loopType,
						streak: typeof result?.streak === "number" ? result.streak : 0,
					};
				} catch {
					/* 采集标注异常不影响管线 */
				}
			},
			noteRuleDecision: (note) => {
				try {
					if (note) pending.rule = { decision: note.decision, matchedRule: note.matchedRule, matchedLayer: note.matchedLayer };
				} catch {
					/* ignore */
				}
			},
			noteClassifier: (note) => {
				try {
					if (note) pending.classifier = { ...note };
				} catch {
					/* ignore */
				}
			},
			noteDialogShown: () => {
				pending.dialogShown = true;
			},
			finishBlocked: () => this.finishInternal(pending, this.deriveBlockSpec(pending)),
			finishAllowed: () => this.finishInternal(pending, this.deriveAllowSpec(pending)),
			finishHuman: (action, dslRule) => this.finishInternal(pending, deriveHumanSpec(action, dslRule)),
		};
	}

	/**
	 * 系统阻断归因：loop_circuit / rule_deny / readonly_sandbox / headless_cap。
	 * headless_cap 为无头语境下系统自决阻断的统一归因（denial-cap、分类器不可用降级、
	 * 分类器判 DENY 而无可核人工、需人工但无 UI 等——枚举收缩为四值，语义即「因无头而被迫系统自决阻断」）。
	 */
	private deriveBlockSpec(pending: PendingCall): FinishSpec {
		const rule = pending.rule;
		const loop = pending.loop;
		if (rule?.decision === "deny") {
			return {
				outcome: "SYSTEM_AUTO_DENIED",
				decisionMaker: "rule",
				denialReason: "rule_deny",
				ruleProvenance: rule.matchedRule
					? { scope: rule.matchedLayer ?? "session", persistedRuleText: rule.matchedRule }
					: undefined,
			};
		}
		if (!rule && loop?.isLoop) {
			return { outcome: "SYSTEM_AUTO_DENIED", decisionMaker: "system", denialReason: "loop_circuit" };
		}
		const mode = pending.input.environment.approvalMode;
		if (mode === "readonly" || mode === "plan") {
			return { outcome: "SYSTEM_AUTO_DENIED", decisionMaker: "system", denialReason: "readonly_sandbox" };
		}
		return { outcome: "SYSTEM_AUTO_DENIED", decisionMaker: "system", denialReason: "headless_cap" };
	}

	/**
	 * 免审放行归因：CLASSIFIER_ALLOWED（分类器）/ FALLBACK_ALLOWED（启发式兜底）/
	 * RULE_ALLOWED（规则短路）/ SYSTEM_ALLOWED（模式策略与工具默认权限层放行——
	 * yolo、auto 常规编辑快路径、auto-edit/manual 文件放行、readonly 沙箱放行、工作区内读取默认放行）。
	 */
	private deriveAllowSpec(pending: PendingCall): FinishSpec {
		const classifier = pending.classifier;
		if (classifier && !classifier.shouldBlock) {
			if (classifier.stage === "fallback") {
				return { outcome: "FALLBACK_ALLOWED", decisionMaker: "heuristic" };
			}
			return { outcome: "CLASSIFIER_ALLOWED", decisionMaker: "classifier" };
		}
		const rule = pending.rule;
		if (rule?.decision === "allow") {
			return {
				outcome: "RULE_ALLOWED",
				decisionMaker: "rule",
				ruleProvenance: rule.matchedRule
					? { scope: rule.matchedLayer ?? "session", persistedRuleText: rule.matchedRule }
					: undefined,
			};
		}
		return { outcome: "SYSTEM_ALLOWED", decisionMaker: "system" };
	}

	private finishInternal(pending: PendingCall, spec: FinishSpec): void {
		try {
			if (pending.finished) return; // 终局唯一：一处一写、重复调用幂等
			pending.finished = true;
			if (pending.aDropped) {
				// 事件 A 因队列溢出被丢弃时，同源丢弃事件 B（保持 A/B 对账一致，杜绝"无头终局"）
				this.counters.droppedQueue++;
				logClassifierWarn(`[ApprovalCapture] 事件 A 已丢弃，事件 B 同源丢弃（callId=${pending.callId}）`);
				return;
			}
			const derived = this.buildDerived(pending, spec);
			const accepted = this.commitRecord(() => this.buildOutcomeRecord(pending.callId, spec, derived));
			if (!accepted) {
				logClassifierWarn(`[ApprovalCapture] 事件 B 落盘失败或丢弃（callId=${pending.callId}）`);
			}
		} catch (err) {
			logClassifierWarn(`[ApprovalCapture] 终局记录异常（已跳过）: ${String(err)}`);
		}
	}

	private buildDerived(pending: PendingCall, spec: FinishSpec): Record<string, unknown> {
		const derived: Record<string, unknown> = {
			pipelinePath: this.buildPipelinePath(pending),
		};
		const shortCircuit = this.buildShortCircuit(pending, spec);
		if (shortCircuit) derived.shortCircuit = shortCircuit;
		if (pending.rule?.matchedRule && pending.rule.matchedLayer) {
			derived.matchedRule = {
				layer: pending.rule.matchedLayer,
				action: pending.rule.decision,
				ruleText: pending.rule.matchedRule,
			};
		}
		const snapshot = this.buildDerivedSnapshot(pending);
		if (snapshot) derived.derivedSnapshot = snapshot;
		if (pending.loop) {
			derived.loopDetectorStatus = { ...pending.loop };
		}
		return derived;
	}

	private buildPipelinePath(pending: PendingCall): string[] {
		const path: string[] = ["loop_check"];
		if (pending.rule) path.push("rule_engine");
		const classifier = pending.classifier;
		if (classifier) {
			if (classifier.stage === "fast") path.push("stage1");
			else if (classifier.stage === "thinking") path.push("stage1", "stage2");
			else path.push("heuristic_fallback");
		}
		if (pending.dialogShown) path.push("dialog");
		return path;
	}

	private buildShortCircuit(pending: PendingCall, spec: FinishSpec): string | undefined {
		if (spec.outcome === "RULE_ALLOWED") return "rule_allow";
		if (pending.rule?.decision === "ask") return "rule_ask";
		if (spec.denialReason === "rule_deny") return "rule_deny";
		if (spec.outcome === "SYSTEM_AUTO_DENIED" && spec.denialReason === "loop_circuit" && !pending.rule) {
			return "loop_circuit";
		}
		return undefined;
	}

	private buildDerivedSnapshot(pending: PendingCall): Record<string, unknown> | undefined {
		const classifier = pending.classifier;
		if (!classifier) return undefined; // 短路路径为空；进入分类器/启发式后非空
		const systemDecision = classifier.shouldBlock
			? classifier.stage === "fallback"
				? "FALLBACK_DENY"
				: "DENY"
			: classifier.stage === "fallback"
				? "FALLBACK_ALLOW"
				: "ALLOW";
		const snapshot: Record<string, unknown> = { systemDecision, stage: classifier.stage };
		if (classifier.stage === "fast") {
			snapshot.stage1Outcome = { decision: "ALLOW", shouldBlock: false };
		} else if (classifier.stage === "thinking") {
			snapshot.stage1Outcome = { decision: "DENY", shouldBlock: true };
			snapshot.stage2Outcome = {
				decision: classifier.shouldBlock ? "DENY" : "ALLOW",
				shouldBlock: classifier.shouldBlock,
				...(classifier.reason ? { reason: classifier.reason } : {}),
			};
		} else {
			snapshot.heuristicOutcome = {
				shouldBlock: classifier.shouldBlock,
				...(classifier.reason ? { reason: classifier.reason } : {}),
				stage: "fallback",
			};
		}
		if (classifier.reason) snapshot.classifierReason = classifier.reason;
		if (classifier.summary) snapshot.classifierSummary = classifier.summary;
		if (classifier.outage) snapshot.classifierOutage = true;
		return snapshot;
	}

	private buildOutcomeRecord(callId: string, spec: FinishSpec, derived?: Record<string, unknown>): Record<string, unknown> {
		const timestamp = this.now();
		const record: Record<string, unknown> = {
			eventType: "human_outcome_recorded",
			callId,
			timestamp,
			isoTime: new Date(timestamp).toISOString(),
			seq: ++this.seqCounter,
			outcome: spec.outcome,
			decisionMaker: spec.decisionMaker,
		};
		if (spec.denialReason) record.denialReason = spec.denialReason;
		if (spec.ruleProvenance) record.ruleProvenance = { ...spec.ruleProvenance };
		if (derived && Object.keys(derived).length > 0) record.derived = derived;
		return record;
	}

	// ==========================================
	// 孤儿对账（双门槛 + 幂等）
	// ==========================================

	private async reconcileOrphans(files: string[]): Promise<number> {
		const eventAByCall = new Map<string, { timestamp: number; pid: number }>();
		const terminatedCalls = new Set<string>();
		for (const file of files) {
			let content: string;
			try {
				content = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const pid = extractPidFromFileName(basename(file));
			for (const line of content.split("\n")) {
				if (!line) continue;
				let record: Record<string, any>;
				try {
					record = JSON.parse(line);
				} catch {
					this.counters.parseErrors++;
					continue;
				}
				const callId = record?.callId;
				if (typeof callId !== "string") continue;
				if (record.eventType === "tool_call_captured") {
					eventAByCall.set(callId, {
						timestamp: typeof record.timestamp === "number" ? record.timestamp : 0,
						pid,
					});
				} else if (record.eventType === "human_outcome_recorded") {
					terminatedCalls.add(callId);
				}
			}
		}
		const nowMs = this.now();
		let written = 0;
		for (const [callId, eventA] of eventAByCall) {
			if (terminatedCalls.has(callId)) continue; // 幂等：任意事件 B 即终态（死而复生拒绝）
			if (nowMs - eventA.timestamp <= CAPTURE_ORPHAN_STALE_MS) continue; // 陈旧阈值
			if (isProcessAlive(eventA.pid)) continue; // 进程存活（弹窗进行中不是孤儿）
			const accepted = this.commitRecord(() => this.buildOutcomeRecord(callId, { outcome: "ORPHANED", decisionMaker: "system" }));
			if (accepted) written++;
		}
		return written;
	}

	// ==========================================
	// 自污染排除
	// ==========================================

	private isSelfCapture(toolName: string, rawArguments: Record<string, unknown>): boolean {
		const probes: string[] = [];
		for (const key of ["path", "file_path", "target_file", "command", "cmd"]) {
			const value = rawArguments?.[key];
			if (typeof value === "string" && value.length > 0) probes.push(value);
		}
		if (probes.length === 0) return false;
		for (const probe of probes) {
			if (
				probe.includes(CAPTURE_DIR_NAME) ||
				probe.includes(CAPTURE_SCRUB_MAP_DIR_NAME) ||
				probe.includes("approval-config.json")
			) {
				return true;
			}
		}
		return false;
	}

	// ==========================================
	// 写队列与落盘
	// ==========================================

	private enqueueTask(task: () => Promise<void>): boolean {
		if (this.queueDepth >= CAPTURE_QUEUE_MAX_DEPTH) {
			this.counters.droppedQueue++;
			logClassifierWarn(
				`[ApprovalCapture] 写队列已满（上限 ${CAPTURE_QUEUE_MAX_DEPTH}），本事件丢弃（累计丢弃 ${this.counters.droppedQueue}）`,
			);
			return false;
		}
		this.queueDepth++;
		this.queueTail = this.queueTail
			.then(task)
			.catch((err) => {
				this.counters.writeErrors++;
				logClassifierWarn(`[ApprovalCapture] 写队列任务异常: ${String(err)}`);
			})
			.finally(() => {
				this.queueDepth--;
			});
		return true;
	}

	/**
	 * 统一落盘提交：默认把「构建 + 脱敏 + 序列化 + 写盘」整体放入写队列（入口零开销）；
	 * syncWrite 模式下内联同步落盘（每条事件同步 fsync，牺牲吞吐换全量，取证/审计场景）。
	 * 返回 false 表示队列溢出丢弃或构建/落盘失败（调用方据此镜像丢弃终局，保持 A/B 对账一致）。
	 */
	private commitRecord(build: () => Record<string, unknown>): boolean {
		try {
			if (this.settings.syncWrite) {
				const startedCpu = this.now();
				const line = this.buildFinalLine(build(), startedCpu);
				syncAppendWithFsync(this.ensureTargetFile(), line);
				this.counters.writes++;
				return true;
			}
			return this.enqueueTask(async () => {
				const startedCpu = this.now();
				const line = this.buildFinalLine(build(), startedCpu);
				await fsp.appendFile(this.ensureTargetFile(), `${line}\n`, "utf8");
				this.counters.writes++;
			});
		} catch (err) {
			this.counters.writeErrors++;
			logClassifierWarn(`[ApprovalCapture] 事件构建/落盘异常: ${String(err)}`);
			return false;
		}
	}

	/** 同步阶段：深拷贝/脱敏（或显式关闭脱敏时的纯深拷贝）→ CPU 预算打标 → 序列化。 */
	private buildFinalLine(record: Record<string, unknown>, startedCpu: number): string {
		let processed: Record<string, unknown>;
		if (this.settings.scrubSecrets) {
			processed = scrubJsonTree(record).value as Record<string, unknown>;
		} else {
			processed = cloneJsonTree(record) as Record<string, unknown>;
		}
		if (this.now() - startedCpu > CAPTURE_EVENT_CPU_BUDGET_MS) {
			processed.scrubBudgetExceeded = true;
			this.counters.scrubBudgetExceeded++;
			logClassifierWarn(`[ApprovalCapture] 事件处理超出 CPU 预算 ${CAPTURE_EVENT_CPU_BUDGET_MS}ms，已打标（数据仍走完整脱敏管道，不降级截断）。`);
		}
		const line = safeStringify(processed);
		if (line === undefined) {
			throw new Error("事件序列化失败（JSON.stringify 返回 undefined）");
		}
		return line;
	}

	private ensureTargetFile(): string {
		if (this.targetFile) return this.targetFile;
		this.ensureDir();
		const uuid8 = this.uuid().replace(/-/g, "").slice(0, 8);
		const file = join(this.captureDir, `${formatLocalDate(this.now())}-${this.pid}-${uuid8}.jsonl`);
		if (!existsSync(file)) {
			writeFileSync(file, "", { mode: 0o600 });
			try {
				chmodSync(file, 0o600);
			} catch {
				/* 权限加固失败不影响采集 */
			}
		}
		this.targetFile = file;
		return file;
	}

	private ensureDir(): void {
		if (!existsSync(this.captureDir)) {
			mkdirSync(this.captureDir, { recursive: true, mode: 0o700 });
			try {
				chmodSync(this.captureDir, 0o700);
			} catch {
				/* ignore */
			}
		}
	}

	private ensurePolicyCas(hash: string, scrubbedText: string): void {
		try {
			this.ensureDir();
			if (!existsSync(this.policyDir)) {
				mkdirSync(this.policyDir, { recursive: true, mode: 0o700 });
				try {
					chmodSync(this.policyDir, 0o700);
				} catch {
					/* ignore */
				}
			}
			const file = join(this.policyDir, `${hash}.md`);
			if (existsSync(file)) return;
			writeFileSync(file, scrubbedText, { encoding: "utf8", mode: 0o600 });
			try {
				chmodSync(file, 0o600);
			} catch {
				/* ignore */
			}
		} catch (err) {
			logClassifierWarn(`[ApprovalCapture] CAS 策略写入失败: ${String(err)}`);
		}
	}

	// ==========================================
	// 目录扫描工具
	// ==========================================

	private listJsonlFiles(): Array<{ name: string; path: string; size: number; mtimeMs: number }> {
		return listCaptureJsonlFiles(this.captureDir);
	}

	private listPolicyFiles(): Array<{ name: string; path: string }> {
		return listCapturePolicyFiles(this.policyDir);
	}

	private policyDirTotalBytes(): number {
		let total = 0;
		for (const file of this.listPolicyFiles()) {
			try {
				total += statSync(file.path).size;
			} catch {
				/* ignore */
			}
		}
		return total;
	}

	private collectReferencedPolicyHashes(files: string[]): Set<string> {
		return scanReferencedPolicyHashes(files);
	}
}

// ==========================================
// 数据集工具（删除权 / 导出权 —— 与采集同批交付的承诺面）
// ==========================================

export interface CaptureDeleteSelector {
	callIds?: string[];
	beforeMs?: number;
	all?: boolean;
	confirmAll?: boolean;
}

export interface CaptureDeleteSummary {
	filesScanned: number;
	recordsScanned: number;
	recordsRemoved: number;
	filesEmptied: number;
	policiesSwept: number;
}

export interface CaptureExportSelector {
	callIds?: string[];
	beforeMs?: number;
}

export interface CaptureExportSummary {
	recordsExported: number;
	callsExported: number;
	outputPath: string;
}

/**
 * 删除采集记录（按 callId / 时间范围 / 全量），并清扫因此失去引用的 CAS 策略文件。
 * 安全删除纪律：空选择器拒绝执行；`all` 必须显式 `confirmAll: true`；损坏行保留不动。
 * 时间范围按记录自身时间戳匹配（A/B 各自独立），边界处可能拆分成对调用。
 */
export function deleteCaptureRecords(captureDir: string, selector: CaptureDeleteSelector): CaptureDeleteSummary {
	const summary: CaptureDeleteSummary = { filesScanned: 0, recordsScanned: 0, recordsRemoved: 0, filesEmptied: 0, policiesSwept: 0 };
	const callIdSet = new Set((selector.callIds ?? []).filter((id): id is string => typeof id === "string" && id.length > 0));
	const useAll = selector.all === true;
	if (useAll && selector.confirmAll !== true) {
		throw new Error("全量删除必须显式确认（confirmAll / --yes）");
	}
	if (!useAll && callIdSet.size === 0 && typeof selector.beforeMs !== "number") {
		throw new Error("删除范围为空：需指定 callIds、beforeMs 或 all 之一");
	}
	const matches = (record: Record<string, unknown>): boolean => {
		if (useAll) return true;
		if (typeof record?.callId === "string" && callIdSet.has(record.callId)) return true;
		if (typeof selector.beforeMs === "number" && typeof record?.timestamp === "number" && record.timestamp <= selector.beforeMs) {
			return true;
		}
		return false;
	};
	for (const file of listCaptureJsonlFiles(captureDir)) {
		summary.filesScanned++;
		let content: string;
		try {
			content = readFileSync(file.path, "utf8");
		} catch {
			continue;
		}
		const kept: string[] = [];
		let removed = 0;
		for (const line of content.split("\n")) {
			if (!line) continue;
			summary.recordsScanned++;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line);
			} catch {
				kept.push(line); // 损坏行保留，交由人工处置
				continue;
			}
			if (matches(record)) {
				removed++;
			} else {
				kept.push(line);
			}
		}
		if (removed === 0) continue;
		summary.recordsRemoved += removed;
		if (kept.length === 0) {
			rmSync(file.path, { force: true });
			summary.filesEmptied++;
		} else {
			const tmpPath = `${file.path}.tmp`;
			writeFileSync(tmpPath, `${kept.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
			renameSync(tmpPath, file.path);
		}
	}
	// 引用清扫：删除后无引用的 CAS 策略一并清理，杜绝悬空与无界残留
	const referenced = scanReferencedPolicyHashes(listCaptureJsonlFiles(captureDir).map((f) => f.path));
	for (const policy of listCapturePolicyFiles(join(captureDir, CAPTURE_POLICY_DIR_NAME))) {
		const hash = basename(policy.name, ".md");
		if (!referenced.has(hash)) {
			rmSync(policy.path, { force: true });
			summary.policiesSwept++;
		}
	}
	return summary;
}

/**
 * 导出采集记录（空选择器 = 全量）为独立 JSONL 文件。
 * 导出前对每条记录执行二次脱敏（与采集同一 scrub 管道，幂等）；输出文件权限 0600。
 */
export function exportCaptureRecords(captureDir: string, selector: CaptureExportSelector, outputPath: string): CaptureExportSummary {
	const callIdSet = new Set((selector.callIds ?? []).filter((id): id is string => typeof id === "string" && id.length > 0));
	const matches = (record: Record<string, unknown>): boolean => {
		if (callIdSet.size === 0 && typeof selector.beforeMs !== "number") return true; // 空选择器 = 全量
		if (typeof record?.callId === "string" && callIdSet.has(record.callId)) return true;
		if (typeof selector.beforeMs === "number" && typeof record?.timestamp === "number" && record.timestamp <= selector.beforeMs) {
			return true;
		}
		return false;
	};
	const outLines: string[] = [];
	const calls = new Set<string>();
	for (const file of listCaptureJsonlFiles(captureDir)) {
		let content: string;
		try {
			content = readFileSync(file.path, "utf8");
		} catch {
			continue;
		}
		for (const line of content.split("\n")) {
			if (!line) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (!matches(record)) continue;
			const scrubbed = scrubJsonTree(record).value as Record<string, unknown>;
			outLines.push(JSON.stringify(scrubbed));
			if (typeof record.callId === "string") calls.add(record.callId);
		}
	}
	if (outLines.length === 0) {
		throw new Error("导出范围为空：未匹配到任何记录（请检查 callId / beforeMs 条件）");
	}
	const outDir = dirname(outputPath);
	if (outDir && !existsSync(outDir)) {
		mkdirSync(outDir, { recursive: true });
	}
	writeFileSync(outputPath, `${outLines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(outputPath, 0o600);
	} catch {
		/* 权限加固失败不影响导出 */
	}
	return { recordsExported: outLines.length, callsExported: calls.size, outputPath };
}

function listCaptureJsonlFiles(captureDir: string): Array<{ name: string; path: string; size: number; mtimeMs: number }> {
	const result: Array<{ name: string; path: string; size: number; mtimeMs: number }> = [];
	try {
		if (!existsSync(captureDir)) return result;
		for (const name of readdirSync(captureDir)) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(captureDir, name);
			try {
				const stat = statSync(path);
				result.push({ name, path, size: stat.size, mtimeMs: stat.mtimeMs });
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}
	return result;
}

function listCapturePolicyFiles(policyDir: string): Array<{ name: string; path: string }> {
	const result: Array<{ name: string; path: string }> = [];
	try {
		if (!existsSync(policyDir)) return result;
		for (const name of readdirSync(policyDir)) {
			if (name.endsWith(".md")) result.push({ name, path: join(policyDir, name) });
		}
	} catch {
		/* ignore */
	}
	return result;
}

function scanReferencedPolicyHashes(files: string[]): Set<string> {
	const referenced = new Set<string>();
	for (const file of files) {
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of content.split("\n")) {
			if (!line || !line.includes("PolicyHash")) continue;
			try {
				const record = JSON.parse(line);
				const policies = record?.policies;
				if (typeof policies?.globalPolicyHash === "string") referenced.add(policies.globalPolicyHash);
				if (typeof policies?.projectPolicyHash === "string") referenced.add(policies.projectPolicyHash);
			} catch {
				/* 损坏行不参与引用集合 */
			}
		}
	}
	return referenced;
}

// ==========================================
// 内部工具函数
// ==========================================

function deriveHumanSpec(action: CaptureHumanAction, dslRule: string): FinishSpec {
	switch (action) {
		case "allow_once":
			return { outcome: "APPROVED_ONCE", decisionMaker: "human" };
		case "allow_session":
			return { outcome: "ALLOWED_SESSION", decisionMaker: "human", ruleProvenance: { scope: "session", persistedRuleText: dslRule } };
		case "allow_project":
			return { outcome: "ALLOWED_PROJECT", decisionMaker: "human", ruleProvenance: { scope: "project", persistedRuleText: dslRule } };
		case "allow_user":
			return { outcome: "ALLOWED_USER", decisionMaker: "human", ruleProvenance: { scope: "user", persistedRuleText: dslRule } };
		case "block_and_abort":
			return { outcome: "REJECTED_AND_ABORT", decisionMaker: "human" };
		case "block":
		default:
			return { outcome: "REJECTED", decisionMaker: "human" };
	}
}

function capSingleField(value: unknown): { value: unknown; truncated: boolean } {
	if (typeof value === "string") {
		const truncated = truncateToBytes(value, CAPTURE_FIELD_CAP_BYTES);
		return { value: truncated.text, truncated: truncated.truncated };
	}
	try {
		const json = JSON.stringify(value);
		if (json !== undefined && Buffer.byteLength(json, "utf8") > CAPTURE_FIELD_CAP_BYTES) {
			const truncated = truncateToBytes(json, CAPTURE_FIELD_CAP_BYTES);
			return { value: truncated.text, truncated: true };
		}
	} catch {
		/* 序列化失败：原样保留，交由脱敏管道处理 */
	}
	return { value, truncated: false };
}

function cloneJsonTree(node: unknown): unknown {
	if (Array.isArray(node)) return node.map((item) => cloneJsonTree(item));
	if (node !== null && typeof node === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			out[key] = cloneJsonTree(value);
		}
		return out;
	}
	return node;
}

function safeStringify(value: unknown): string | undefined {
	try {
		const result = JSON.stringify(value);
		return typeof result === "string" ? result : undefined;
	} catch {
		return undefined;
	}
}

function safeJsonByteSize(value: unknown): number {
	const line = safeStringify(value);
	return line === undefined ? 0 : Buffer.byteLength(line, "utf8");
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function formatLocalDate(timestamp: number): string {
	const date = new Date(timestamp);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function extractPidFromFileName(name: string): number {
	const match = name.match(/^\d{4}-\d{2}-\d{2}-(\d+)-[0-9a-f]{8}\.jsonl$/);
	return match ? Number(match[1]) : Number.NaN;
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return true; // 无法判定一律按存活处理（保守方向：漏标不误标）
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as { code?: string } | undefined)?.code;
		return code === "EPERM"; // 进程存在但无权限探测
	}
}

function syncAppendWithFsync(file: string, line: string): void {
	const fd = openSync(file, "a", 0o600);
	try {
		writeSync(fd, `${line}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
