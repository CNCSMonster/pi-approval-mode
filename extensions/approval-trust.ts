/**
 * 审批配置与规则文件工作区信任闸门禁 (Project Approval Trust Gate)
 *
 * 核心设计意图与安全约束：
 * 1. 消除未知仓库静默放行盲区：
 *    当工作区仅包含项目级审批配置（.pi/approval-rules.json、.pi/approval-policy.md、.pi/approval-config.json）
 *    而缺少 Pi 原生受控资源（settings.json 等）时，上游 hasTrustRequiringProjectResources 会返回 false，
 *    导致上游 resolveProjectTrusted() 盲区性直接放行 (return true)。
 *    本模块在此类工作区下介入裁决，阻止恶意仓库注入自然语言偏置策略或宽松的 allow 规则。
 * 2. 信任源单一性 (SSOT)：
 *    复用官方导出的 hasTrustRequiringProjectResources、ProjectTrustStore 与 parseArgs，
 *    读取与写入严格对齐 ~/.pi/agent/trust.json，继承原生符号链接归一化与原子文件锁。
 * 3. 安全序与 Fail-Closed 底线：
 *    - CLI --no-approve / -na 享有一票否决权，无论历史为何一律强制阻断；
 *    - CLI --approve / -a 拥有最高优先级的显式信任背书；
 *    - 无头/非交互环境与 RPC 模式下，未授权审批资源严格降级阻断，避免挂死自动化跑道；
 *    - 对话框 Esc/取消时严格返回 false 且不写盘。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	parseArgs,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { logClassifierWarn, logClassifierDebug } from "./logger.ts";

/** 本扩展管辖的项目级安全审批配置文件列表（均位于 <cwd>/.pi/ 下） */
export const APPROVAL_PROJECT_RESOURCES = [
	"approval-rules.json",
	"approval-policy.md",
	"approval-config.json",
] as const;

/**
 * 探测当前工作区是否包含本插件管辖的项目级安全审批配置。
 * 三类文件均为直接位于 `<cwd>/.pi/` 目录下的固定文件名，无祖先目录走查。
 */
export function hasApprovalProjectResources(cwd: string): boolean {
	const piDir = join(cwd, ".pi");
	return APPROVAL_PROJECT_RESOURCES.some((file) => existsSync(join(piDir, file)));
}

/**
 * 列出当前工作区中实际存在的审批配置文件列表（用于 UI 透明通知与诊断日志）。
 */
export function getActiveApprovalProjectResources(cwd: string): string[] {
	const piDir = join(cwd, ".pi");
	return APPROVAL_PROJECT_RESOURCES.filter((file) => existsSync(join(piDir, file))).map(
		(f) => `.pi/${f}`,
	);
}

/**
 * 计算有效的父目录路径（用于对齐原生 Trust parent folder 选项）。
 */
export function getProjectTrustParentPath(cwd: string): string | undefined {
	const current = resolve(cwd);
	const parent = dirname(current);
	return parent === current ? undefined : parent;
}

/**
 * 读取全局 settings.json 中的 defaultProjectTrust 偏好设置。
 * 必须读取全局 <agentDir>/settings.json（~/.pi/agent/settings.json），项目级配置绝不参与。
 */
export function readGlobalDefaultProjectTrust(agentDir: string): "always" | "never" | "ask" {
	const globalSettingsPath = join(agentDir, "settings.json");
	if (!existsSync(globalSettingsPath)) {
		return "ask";
	}
	try {
		const raw = readFileSync(globalSettingsPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed.defaultProjectTrust === "always" || parsed.defaultProjectTrust === "never") {
			return parsed.defaultProjectTrust;
		}
	} catch {
		// 忽略读取与解析异常，回退安全默认 ask
	}
	return "ask";
}

interface TrustPromptOption {
	label: string;
	trusted: boolean;
	sessionOnly: boolean;
	updates: Array<{ path: string; decision: boolean | null }>;
}

/**
 * 格式化审批配置专属信任对话框提示文本（明示对 trust.json 的影响与安全边界）。
 */
export function formatProjectApprovalTrustPrompt(cwd: string, activeFiles: string[]): string {
	const fileList = activeFiles.map((f) => `- ${f}`).join("\n");
	return (
		`Trust project approval policies and rules?\n${cwd}\n\n` +
		`This workspace contains project-level approval configurations:\n${fileList}\n\n` +
		`Allowing this project lets it customize security policies and bypass confirmation prompts.\n` +
		`This decision will update your workspace trust setting in trust.json.`
	);
}

/**
 * 交互模式下弹出心智对齐的 5 选项信任对话框。
 */
export async function promptProjectApprovalTrust(
	cwd: string,
	ctx: ExtensionContext,
	trustStore: ProjectTrustStore,
	activeFiles: string[],
): Promise<{ trusted: boolean; sessionOnly: boolean }> {
	const parentPath = getProjectTrustParentPath(cwd);
	const options: TrustPromptOption[] = [
		{
			label: "Trust",
			trusted: true,
			sessionOnly: false,
			updates: [{ path: cwd, decision: true }],
		},
	];

	if (parentPath !== undefined) {
		options.push({
			label: `Trust parent folder (${parentPath})`,
			trusted: true,
			sessionOnly: false,
			// 父目录赋权同时清理子目录冗余条目，防止历史负条目遮蔽父目录信任
			updates: [
				{ path: parentPath, decision: true },
				{ path: cwd, decision: null },
			],
		});
	}

	options.push(
		{
			label: "Trust (this session only)",
			trusted: true,
			sessionOnly: true,
			updates: [],
		},
		{
			label: "Do not trust",
			trusted: false,
			sessionOnly: false,
			updates: [{ path: cwd, decision: false }],
		},
		{
			label: "Do not trust (this session only)",
			trusted: false,
			sessionOnly: true,
			updates: [],
		},
	);

	const promptText = formatProjectApprovalTrustPrompt(cwd, activeFiles);
	const selectedLabel = await ctx.ui.select(
		promptText,
		options.map((o) => o.label),
	);

	const selected = options.find((o) => o.label === selectedLabel);
	if (!selected) {
		// 用户按 Esc 或取消：Fail-closed，严格返回 false 且不写盘
		logClassifierDebug(`[ApprovalTrust] User cancelled trust prompt for ${cwd}; defaulting to untrusted.`);
		return { trusted: false, sessionOnly: false };
	}

	if (selected.updates.length > 0) {
		try {
			trustStore.setMany(selected.updates);
		} catch (err: any) {
			logClassifierWarn(`[ApprovalTrust] Failed to persist trust decision to trustStore: ${err?.message || err}`);
		}
	}

	return { trusted: selected.trusted, sessionOnly: selected.sessionOnly };
}

export interface ResolveEffectiveProjectTrustOptions {
	cwd: string;
	ctx: ExtensionContext;
	agentDir: string;
	sessionTrustCache: Map<string, boolean>;
}

/**
 * 求解当前工作区真实有效的项目级信任状态 (Effective Project Trust)。
 * 严格依据 SSOT 优先级链路执行决议，封堵原生盲区漏检漏洞。
 */
export async function resolveEffectiveProjectTrust(
	options: ResolveEffectiveProjectTrustOptions,
): Promise<boolean> {
	const { cwd, ctx, agentDir, sessionTrustCache } = options;

	// 1. 若 Pi 原生已明确否决（例如 --no-approve 或全局配置 never 或用户在原生弹窗拒绝），享有一票否决权
	const nativeTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
	if (!nativeTrusted) {
		logClassifierDebug(`[ApprovalTrust] Native project trust is false for ${cwd}; denying project approval configs.`);
		return false;
	}

	// 2. 检查是否包含审批专属配置资源
	const hasApprovalResources = hasApprovalProjectResources(cwd);
	if (!hasApprovalResources) {
		return nativeTrusted;
	}

	const activeFiles = getActiveApprovalProjectResources(cwd);

	// 3. 若工作区同时包含 Pi 原生受控资源（settings.json 等），说明 Pi 原生裁决已覆盖本工作区（含交互或策略来源），插件不重复裁决
	const hasNativeResources = hasTrustRequiringProjectResources(cwd);
	if (hasNativeResources) {
		if (ctx.hasUI && activeFiles.length > 0) {
			ctx.ui.notify(`[ApprovalTrust] Active project approval configs: ${activeFiles.join(", ")}`, "info");
		}
		return nativeTrusted;
	}

	// 4. 此时处于 Pi 原生漏检盲区（仅含审批配置，且 nativeTrusted 为默认的 true）：
	// 检查 CLI 是否显式传递了 --approve / -a（通过官方 parseArgs 安全解析，消除参数吞词漂移）
	try {
		const parsedArgs = parseArgs(process.argv.slice(2));
		if (parsedArgs.projectTrustOverride === true) {
			logClassifierDebug(`[ApprovalTrust] CLI projectTrustOverride is true for ${cwd}; allowing project approval configs.`);
			return true;
		}
	} catch {
		// 忽略 CLI 解析异常，继续后续正规信任链检查
	}

	// 5. 检查会话级临时信任缓存（跨 tool_call 与 reload 保持）
	if (sessionTrustCache.has(cwd)) {
		const cached = sessionTrustCache.get(cwd)!;
		logClassifierDebug(`[ApprovalTrust] Hit session trust cache for ${cwd}: ${cached}`);
		return cached;
	}

	// 6. 查询官方 ProjectTrustStore (读取 ~/.pi/agent/trust.json，带符号链接归一化与父目录继承)
	const trustStore = new ProjectTrustStore(agentDir);
	const storedDecision = trustStore.get(cwd);
	if (storedDecision !== null) {
		logClassifierDebug(`[ApprovalTrust] Found stored decision in trustStore for ${cwd}: ${storedDecision}`);
		return storedDecision;
	}

	// 7. 查询全局 ~/.pi/agent/settings.json 中的 defaultProjectTrust ("always" | "never" | "ask")
	const defaultTrust = readGlobalDefaultProjectTrust(agentDir);
	if (defaultTrust === "always") {
		logClassifierDebug(`[ApprovalTrust] defaultProjectTrust is always; allowing project approval configs for ${cwd}`);
		return true;
	}
	if (defaultTrust === "never") {
		logClassifierDebug(`[ApprovalTrust] defaultProjectTrust is never; denying project approval configs for ${cwd}`);
		return false;
	}

	// 8. 无头/非交互环境、RPC 自动化模式或 UI 缺少 select 组件时，执行最小权限安全降级（避免挂死跑道）
	if (!ctx.hasUI || ctx.mode === "rpc" || typeof ctx.ui?.select !== "function") {
		logClassifierWarn(
			`[ApprovalTrust] Untrusted workspace with approval resources in headless/RPC/no-select mode: ${cwd}; blocking project approval configs.`,
		);
		return false;
	}

	// 9. 交互模式弹出心智对齐的 5 选项信任对话框
	const decision = await promptProjectApprovalTrust(cwd, ctx, trustStore, activeFiles);
	if (decision.sessionOnly) {
		sessionTrustCache.set(cwd, decision.trusted);
	}
	return decision.trusted;
}
