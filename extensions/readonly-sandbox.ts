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

/** git branch 只读查询类 flag (列举 / 指向 / 包含关系) */
const GIT_BRANCH_QUERY_FLAGS = new Set([
	"--list", "-l", "--points-at", "--merged", "--no-merged", "--contains",
	"--no-contains", "--show-current", "--all", "-a", "--column",
]);

/** git branch 变更类 flag (删除 / 重命名 / 创建 / 跟踪关系变更) */
const GIT_BRANCH_ALTER_FLAGS = new Set([
	"-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy",
	"--force", "-f", "--edit-description", "--set-upstream-to", "-u", "--unset-upstream",
]);

/** git tag 只读查询类 flag */
const GIT_TAG_QUERY_FLAGS = new Set([
	"--list", "-l", "--points-at", "--contains", "--no-contains",
]);

/** git tag 变更类 flag (删除 / 创建 / 校验消息以外的写入) */
const GIT_TAG_ALTER_FLAGS = new Set([
	"-d", "--delete", "-a", "--annotate", "-s", "--sign", "-u",
	"-m", "--message", "--force", "-f",
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
 * 校验命令是否包含非法的输出写入重定向（>, >>, &>, 1>, 2> 等）。
 * 豁免合法的黑洞流丢弃（如 2>/dev/null, >/dev/null, &>/dev/null, 2>NUL, >NUL）。
 */
export function hasDisallowedOutputRedirection(cmd: string): boolean {
	let cleaned = cmd.replace(/(?:[0-2]?|&)>\s*(?:\/dev\/null|NUL)\b/gi, "");
	// 豁免描述符复制（如 2>&1, 1>&2）
	cleaned = cleaned.replace(/[0-2]?>&[0-2]/g, "");
	return /(?:^|[^<])>{1,2}/.test(cleaned);
}

/**
 * Tier 1 静态纵深拦截的 npm 只读子命令 (与 Tier 2 白名单同口径，另加纯查询类)
 */
const TIER1_READONLY_NPM_SUBCOMMANDS = new Set([
	"test",
	"run",
	"-v",
	"--version",
	"view",
	"info",
	"ls",
	"list",
	"outdated",
	"audit",
	"ping",
	"help",
	"docs",
]);

/**
 * Tier 1 静态拦截的已知写意图与远程/会话副作用工具：
 * - 本地写意图：删除、移动、权限变更、归档解包等（提供 0ms 清晰归因，避免白名单式扼杀）；
 * - 远程副作用：SSH 会话、包管理器写入、云/容器/编排 CLI 等——内核沙盒只能约束文件写入，
 *   无法约束网络与远端状态变更，必须在静态层拦截。
 * 注：本表是黑名单而非白名单——未命中的未知命令一律交由 Tier 1 内核沙盒执行。
 */
const TIER1_BLOCKED_BINS = new Set([
	// 本地文件写意图
	"rm", "rmdir", "unlink", "mv", "cp", "ln", "mkdir", "touch", "tee",
	"dd", "shred", "wipefs", "truncate", "install", "chmod", "chown", "chgrp",
	"del", "rd", "zip", "unzip", "gunzip", "bunzip2",
	// 编译器与链接器（确定性产出构建产物，判定为写意图）
	"gcc", "g++", "cc", "c++", "clang", "clang++", "clang-cl", "tcc",
	"rustc", "javac", "kotlinc", "scalac", "nvcc", "zig", "nasm", "yasm",
	"ld", "as", "mcs",
	// 远程 / 会话副作用（沙盒无法约束）
	"ssh", "scp", "sftp", "rsync", "ftp", "telnet", "sudo", "su",
	// 包管理器与运行器 (npm 由子命令另行判定)
	"pip", "pip3", "pipenv", "poetry", "uv", "yarn", "pnpm", "bun", "bunx", "npx",
	"gem", "composer",
	// 容器 / 云 / 编排 / IaC CLI
	"docker", "podman", "kubectl", "terraform", "pulumi", "aws", "gcloud", "az", "gh",
	"heroku", "flyctl",
	// 系统状态与系统包管理
	"systemctl", "service", "launchctl", "mount", "umount",
	"brew", "apt", "apt-get", "yum", "dnf", "pacman", "apk", "snap", "choco",
]);

/**
 * Tier 1 静态纵深拦截 :
 * 在内核沙盒包裹之前，仅以零成本规则拦截「明显的本地写意图」与「沙盒无法约束的
 * 远程/会话副作用」命令；未命中者一律放行交由 Tier 1 内核沙盒执行，
 * 不再受 Tier 2 白名单提前扼杀 (python test.py / pytest 等复杂探查可正常执行)。
 * Tier 2 (无沙盒) 环境不适用本函数，仍走严格白名单降级。
 */
export function evaluateTier1StaticReadonlyGate(command: string): { isSafe: boolean; reason?: string } {
	const trimmed = command.trim();
	if (!trimmed) return { isSafe: true };

	// 1) 文件写入重定向 (豁免 /dev/null 与 NUL 黑洞)
	if (hasDisallowedOutputRedirection(trimmed)) {
		return { isSafe: false, reason: "Output redirection (>, >>) attempts to write files" };
	}

	// 2) 按复合操作符切分，逐段静态分析
	const segments = trimmed
		.split(/(?:&&|\|\||;|\|)/)
		.map((s) => s.trim())
		.filter(Boolean);

	for (const seg of segments) {
		const words = seg.split(/\s+/).filter(Boolean);
		if (words.length === 0) continue;
		let bin = words[0];
		if (bin.includes("/")) bin = bin.split("/").pop() || bin;
		const args = words.slice(1);

		// 2.1 git: 子命令级只读语义 (push/commit/reset/--output/破坏性子命令一律拦截)
		if (bin === "git") {
			const verdict = evaluateSingleCommandReadOnly(seg);
			if (!verdict.isSafe) return verdict;
			continue;
		}

		// 2.2 npm: 只读子命令放行，publish/install 等写入类拦截
		if (bin === "npm") {
			const sub = args[0] ?? "";
			if (args.length > 0 && !TIER1_READONLY_NPM_SUBCOMMANDS.has(sub)) {
				return { isSafe: false, reason: `npm ${sub} is not a read-only subcommand` };
			}
			continue;
		}

		// 2.3 curl / wget: 仅放行 GET 类读取，拦截上传与非 GET 方法
		if (bin === "curl" || bin === "wget") {
			const mutates = args.some(
				(a) =>
					a === "-d" || a.startsWith("-d") || a.startsWith("--data") ||
					a === "-F" || a.startsWith("--form") ||
					a === "-T" || a.startsWith("--upload") ||
					a === "-X" || a.startsWith("-X") || a === "--request" ||
					a === "--post-data" || a === "--post-file" || a === "--method",
			);
			if (mutates) {
				return { isSafe: false, reason: `${bin} with upload/non-GET method is forbidden in read-only mode` };
			}
			continue;
		}

		// 2.4 原地编辑与归档写入的参数级拦截
		if (bin === "sed" && args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place")) {
			return { isSafe: false, reason: "sed -i (in-place editing) is forbidden in read-only mode" };
		}
		if (
			bin === "tar" &&
			args.some(
				(a) =>
					a === "--extract" || a === "--create" ||
					(!a.startsWith("--") && /^-[a-zA-Z]/.test(a) && /[cx]/.test(a.slice(1))),
			)
		) {
			return { isSafe: false, reason: "tar create/extract writes files and is forbidden in read-only mode" };
		}
		if (bin === "find" && args.includes("-delete")) {
			return { isSafe: false, reason: "find -delete alters filesystem in read-only mode" };
		}
		// awk/gawk/mawk 的 system() 可执行任意命令，脱离静态研判与沙盒预期
		if (bin.endsWith("awk") && seg.includes("system(")) {
			return { isSafe: false, reason: "awk system() executes arbitrary commands in read-only mode" };
		}

		// 2.5 已知写意图 / 远程副作用黑名单与 mkfs 变体
		if (TIER1_BLOCKED_BINS.has(bin) || bin === "mkfs" || bin.startsWith("mkfs.")) {
			return { isSafe: false, reason: `write-intent or remote-effect command "${bin}" is forbidden in read-only mode` };
		}
	}

	return { isSafe: true };
}

/**
 * 严格只读命令白名单检验（Tier 2 降级模式）
 */
export function evaluateStrictReadOnlyCommand(command: string): { isSafe: boolean; reason?: string } {
	const trimmed = command.trim();
	if (!trimmed) {
		return { isSafe: true };
	}

	// 1. 拦截非法写入重定向符号 (>, >>, 1>, 2>, &>)，放行合法的 /dev/null 与 NUL
	if (hasDisallowedOutputRedirection(trimmed)) {
		return {
			isSafe: false,
			reason: "Output redirection (>, >>) is forbidden in read-only mode",
		};
	}

	// 2. 拦截命令替换语法 ($() 与 ``)，防止通过子进程执行非白名单任意命令
	if (/\$\(/.test(trimmed) || /`/.test(trimmed)) {
		return {
			isSafe: false,
			reason: "Command substitution ($() or ``) is forbidden in read-only mode",
		};
	}

	// 3. 切分复合命令（;, &&, ||, |）并逐一校验
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

		// 识别并跳过前置全局 flags（如 git -C <dir>, git --no-pager, git -c <k=v>）以定位真实子命令
		let gitSub: string | undefined;
		let subIndex = 1;
		while (subIndex < parts.length) {
			const p = parts[subIndex];
			if (p === "-C" || p === "-c") {
				subIndex += 2; // 跳过 flag 及其参数值
				continue;
			}
			if (p.startsWith("-")) {
				subIndex++;
				continue;
			}
			gitSub = p;
			break;
		}

		if (!gitSub) return { isSafe: true };

		if (SAFE_GIT_SUBCOMMANDS.has(gitSub)) {
			const subArgs = parts.slice(subIndex + 1);

			// 深入检查是否有危险 flags
			if (gitSub === "stash" && subArgs[0] !== "list" && subArgs[0] !== "show") {
				return { isSafe: false, reason: `git stash ${subArgs[0] ?? ""} alters repository state` };
			}
			// 落盘型输出参数：git log/show/diff --output=<file> 会绕过重定向拦截直接写文件
			for (const sa of subArgs) {
				if (sa === "--output" || sa.startsWith("--output=")) {
					return { isSafe: false, reason: `${gitSub} --output writes files and is forbidden in read-only mode` };
				}
			}
			if (gitSub === "config" && subArgs.length > 0) {
				// 只读查询类参数放行 (--get*, --list, -l)，其余写入类一律拦截
				const isQuery = subArgs.some(
					(a) => a.startsWith("--get") || a === "--list" || a === "-l",
				);
				if (!isQuery) {
					return { isSafe: false, reason: `git config ${subArgs[0]} may alter configuration` };
				}
			}
			if (gitSub === "branch") {
				// 查询模式 (列举/指向/包含关系)：参数中含有查询类 flag 即视为只读查询
				const isQuery = subArgs.some(
					(a) =>
						GIT_BRANCH_QUERY_FLAGS.has(a) ||
						a.startsWith("--points-at=") ||
						a.startsWith("--format=") ||
						a.startsWith("--sort="),
				);
				if (!isQuery) {
					for (const ba of subArgs) {
						if (GIT_BRANCH_ALTER_FLAGS.has(ba) || !ba.startsWith("-")) {
							return { isSafe: false, reason: `git branch ${ba} alters repository branches` };
						}
					}
				}
			}
			if (gitSub === "tag") {
				const isQuery = subArgs.some(
					(a) =>
						GIT_TAG_QUERY_FLAGS.has(a) ||
						a.startsWith("--points-at=") ||
						a.startsWith("--format=") ||
						a.startsWith("--sort=") ||
						(a.startsWith("-n") && !a.startsWith("--")),
				);
				if (!isQuery) {
					for (const ta of subArgs) {
						if (GIT_TAG_ALTER_FLAGS.has(ta) || !ta.startsWith("-")) {
							return { isSafe: false, reason: `git tag ${ta} alters repository tags` };
						}
					}
				}
			}
			if (gitSub === "remote") {
				const isQuery = subArgs.some(
					(a) => a === "-v" || a === "--verbose" || a === "show" || a === "get-url",
				);
				if (!isQuery) {
					return { isSafe: false, reason: `git remote ${subArgs[0]} alters remotes` };
				}
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
