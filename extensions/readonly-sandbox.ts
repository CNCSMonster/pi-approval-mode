/**
 * readonly-sandbox.ts
 *
 * 跨平台只读探查执行沙盒与分层防御模块 
 *
 * 核心架构：
 * 1. Tier 1（内核级只读沙盒）：
 *    - macOS: 使用原生 sandbox-exec 全盘阻断写操作；
 *    - Linux: 若系统具备 bubblewrap (bwrap)，使用轻量非特权沙箱做全盘只读绑定；
 * 2. Tier 2（严格只读命令白名单降级）：
 *    - Windows (PowerShell/cmd) 或缺失 bwrap 的环境：自动平滑降级为严格命令白名单；
 *    - 阻断写入重定向 (>, >>) 与非只读探查命令，并给出免责建议；
 * 3. 客观报错反馈契约：
 *    - 写入工具 (edit/write) 与非法命令直接返回 EROFS 客观物理错误，驱动 Agent 自发纠偏。
 */

import { execSync } from "node:child_process";
import fs from "node:fs";

// 严格只读命令白名单（用于 Tier 2 降级环境）
export const STRICT_READONLY_COMMAND_ROOTS = new Set([
	"git",
	"ls",
	"dir",
	"cat",
	"head",
	"tail",
	"grep",
	"rg",
	"find",
	"findstr",
	"pwd",
	"which",
	"where",
	"env",
	"printenv",
	"echo",
	"type",
	"cargo check",
	"cargo test",
	"npm test",
	"npm run test",
	"node -v",
	"npm -v",
	"python --version",
	"python3 --version",
	"git status",
	"git diff",
	"git log",
	"git show",
	"git branch",
	"git remote",
]);

// Git 允许的只读子命令
export const SAFE_GIT_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"branch",
	"remote",
	"tag",
	"describe",
	"rev-parse",
	"config",
	"ls-files",
	"grep",
	"blame",
	"shortlog",
	"stash",
]);

export interface SandboxCapability {
	platform: NodeJS.Platform;
	tier: "tier1_seatbelt" | "tier1_bwrap" | "tier2_allowlist";
	isSandboxSupported: boolean;
	advisoryNotice?: string;
}

export interface WrapCommandResult {
	command: string;
	sandboxed: boolean;
	tier: "tier1_seatbelt" | "tier1_bwrap" | "tier2_allowlist";
}

let cachedBwrapAvailable: boolean | undefined;

/**
 * 探测 Linux 系统下 bubblewrap (bwrap) 是否可用
 */
export function isBubblewrapAvailable(): boolean {
	if (cachedBwrapAvailable !== undefined) {
		return cachedBwrapAvailable;
	}
	if (process.platform !== "linux") {
		cachedBwrapAvailable = false;
		return false;
	}
	try {
		execSync("bwrap --version", { stdio: "ignore", timeout: 1000 });
		cachedBwrapAvailable = true;
	} catch {
		cachedBwrapAvailable = false;
	}
	return cachedBwrapAvailable;
}

/**
 * 重置 bwrap 缓存探测结果（便于单测模拟）
 */
export function resetBwrapCacheForTesting(value?: boolean): void {
	cachedBwrapAvailable = value;
}

/**
 * 探测 macOS 下 sandbox-exec 是否存在且可用
 */
export function isSeatbeltAvailable(): boolean {
	if (process.platform !== "darwin") {
		return false;
	}
	return fs.existsSync("/usr/bin/sandbox-exec");
}

/**
 * 检测当前宿主平台的沙盒防护能力分层
 */
export function detectSandboxCapability(overridePlatform?: NodeJS.Platform): SandboxCapability {
	const platform = overridePlatform ?? process.platform;

	if (platform === "darwin" && (overridePlatform ? true : isSeatbeltAvailable())) {
		return {
			platform,
			tier: "tier1_seatbelt",
			isSandboxSupported: true,
		};
	}

	if (platform === "linux") {
		const hasBwrap = overridePlatform ? (cachedBwrapAvailable ?? false) : isBubblewrapAvailable();
		if (hasBwrap) {
			return {
				platform,
				tier: "tier1_bwrap",
				isSandboxSupported: true,
			};
		}
		return {
			platform,
			tier: "tier2_allowlist",
			isSandboxSupported: false,
			advisoryNotice:
				"Linux 内核沙盒组件 bubblewrap (bwrap) 未安装，已平滑降级为严格只读命令白名单。建议运行 sudo apt install bubblewrap 以升级至内核级只读沙盒。",
		};
	}

	return {
		platform,
		tier: "tier2_allowlist",
		isSandboxSupported: false,
		advisoryNotice:
			platform === "win32"
				? "Windows 环境已启用严格只读命令白名单防护。"
				: "当前环境已启用严格只读命令白名单防护。",
	};
}

/**
 * 严格只读命令白名单检验（Tier 2 降级模式）
 */
export function evaluateStrictReadOnlyCommand(command: string): { isSafe: boolean; reason?: string } {
	const trimmed = command.trim();
	if (!trimmed) {
		return { isSafe: true };
	}

	// 1. 拦截任何写入重定向符号 (>, >>, 1>, 2>, &>)
	if (/(?:^|[^<])>{1,2}(?:\s*&1|\s*&2)?/g.test(trimmed)) {
		return {
			isSafe: false,
			reason: "Output redirection (>, >>) is forbidden in read-only mode",
		};
	}

	// 2. 切分复合命令（;, &&, ||, |）并逐一校验
	const subCommands = trimmed
		.split(/(?:&&|\|\||;|\|)/)
		.map((cmd) => cmd.trim())
		.filter(Boolean);

	for (const subCmd of subCommands) {
		const verdict = evaluateSingleCommandReadOnly(subCmd);
		if (!verdict.isSafe) {
			return verdict;
		}
	}

	return { isSafe: true };
}

/**
 * 校验单条子命令是否在只读探查白名单内
 */
function evaluateSingleCommandReadOnly(subCmd: string): { isSafe: boolean; reason?: string } {
	const parts = subCmd.split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { isSafe: true };

	const root = parts[0];

	// 特殊处理 git
	if (root === "git") {
		if (parts.length === 1) return { isSafe: true };
		const gitSub = parts[1];
		if (SAFE_GIT_SUBCOMMANDS.has(gitSub)) {
			// 深入检查是否有危险 flags
			if (gitSub === "stash" && parts[2] !== "list" && parts[2] !== "show") {
				return { isSafe: false, reason: `git stash ${parts[2] ?? ""} alters repository state` };
			}
			if (
				gitSub === "config" &&
				parts[2] &&
				parts[2] !== "--get" &&
				parts[2] !== "--list" &&
				parts[2] !== "-l"
			) {
				return { isSafe: false, reason: `git config ${parts[2]} may alter configuration` };
			}
			return { isSafe: true };
		}
		return {
			isSafe: false,
			reason: `git subcommand "${gitSub}" is not in safe read-only allowlist`,
		};
	}

	// 特殊处理 cargo
	if (root === "cargo") {
		if (parts.length > 1 && (parts[1] === "check" || parts[1] === "test" || parts[1] === "clippy")) {
			return { isSafe: true };
		}
		return { isSafe: false, reason: `cargo ${parts[1] ?? ""} is not in safe read-only allowlist` };
	}

	// 特殊处理 npm
	if (root === "npm") {
		if (
			parts.length > 1 &&
			(parts[1] === "test" ||
				(parts[1] === "run" && parts[2] === "test") ||
				parts[1] === "-v" ||
				parts[1] === "--version")
		) {
			return { isSafe: true };
		}
		return { isSafe: false, reason: `npm ${parts[1] ?? ""} is not in safe read-only allowlist` };
	}

	// 允许的常规只读工具
	const allowedRoots = new Set([
		"ls",
		"dir",
		"cat",
		"head",
		"tail",
		"grep",
		"rg",
		"find",
		"findstr",
		"pwd",
		"which",
		"where",
		"env",
		"printenv",
		"echo",
		"type",
		"wc",
		"diff",
		"basename",
		"dirname",
		"uname",
		"whoami",
	]);

	if (allowedRoots.has(root)) {
		return { isSafe: true };
	}

	return {
		isSafe: false,
		reason: `command "${root}" is not in strict read-only allowlist`,
	};
}

/**
 * 将命令行字符串安全包装为系统级只读沙盒命令
 */
export function wrapReadOnlyBashCommand(
	rawCommand: string,
	capability: SandboxCapability,
): WrapCommandResult {
	const trimmed = rawCommand.trim();

	// 1. Tier 1: macOS Seatbelt
	if (capability.tier === "tier1_seatbelt") {
		const escaped = trimmed.replace(/'/g, "'\\''");
		const wrapped = `sandbox-exec -p '(version 1)(allow default)(deny file-write*)' /bin/sh -c '${escaped}'`;
		return {
			command: wrapped,
			sandboxed: true,
			tier: "tier1_seatbelt",
		};
	}

	// 2. Tier 1: Linux Bubblewrap
	if (capability.tier === "tier1_bwrap") {
		const escaped = trimmed.replace(/'/g, "'\\''");
		const wrapped = `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs /run /bin/sh -c '${escaped}'`;
		return {
			command: wrapped,
			sandboxed: true,
			tier: "tier1_bwrap",
		};
	}

	// 3. Tier 2: 严格白名单降级
	return {
		command: rawCommand,
		sandboxed: false,
		tier: "tier2_allowlist",
	};
}

/**
 * 构造客观的 EROFS 物理报错信息（驱动模型自我纠偏）
 */
export function formatReadOnlyFileError(filePath: string): string {
	return `Error: EROFS: read-only file system, open '${filePath}'. The environment is currently in Read-Only mode. Propose file modifications or design solutions in your text response instead of executing edits.`;
}

/**
 * 构造命令被白名单阻断的客观信息
 */
export function formatReadOnlyCommandBlocked(cmd: string, reason: string): string {
	return `[Read-Only Mode] Command execution blocked by read-only policy: "${cmd}" (${reason}). Only safe exploration and inspection commands are permitted.`;
}

/**
 * 只读模式正向引导提示词（作为当前轮次附注注入）
 */
export const READONLY_MODE_SYSTEM_REMINDER = `<system-reminder>
Environment Mode: Read-Only.
Your file-writing capabilities are restricted for safe codebase exploration. Focus on reading files, investigating architecture, and outlining step-by-step solutions directly in your response text.
</system-reminder>`;
