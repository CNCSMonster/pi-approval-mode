/**
 * Permission Engine and DSL Rule Matcher
 *
 * 对齐 Qwen Code 的三态权限规则控制体系与 DSL 语法引擎：
 *
 * 1. 三态判定优先级：
 *    Deny (3, 最高) > Ask (2) > Default (1) > Allow (0)
 *    - deny: 运行时直接阻断，向模型返回错误原因，不触发用户弹窗；
 *    - ask:  强制挂起并弹窗要求用户确认，压倒 allow；
 *    - allow: 免审放行（受 auto 模式高危暂存保护）；
 *    - default: 未命中显式规则，回退至当前审批模式 (default/auto-edit/auto/plan/yolo)。
 *
 * 2. DSL 语法与分流解析：
 *    ToolName 或 ToolName(specifier)
 *    - 宏分类：
 *      • Read(...) -> read, read_file, grep, grep_search, glob, list_directory, zoom_image
 *      • Edit(...) -> edit, write, write_file, notebook_edit
 *      • Bash(...) -> bash, run_shell_command, monitor
 *    - 命令匹配 (Bash)：单词边界 + 环境变量剥离 + 通配符匹配 (如 "git *", "npm test*")
 *    - 路径匹配 (Read/Edit)：
 *      • "//etc/**"  -> 从文件系统绝对根开始 (/etc/**)
 *      • "~/.ssh/**" -> 相对于用户家目录 (~/...)
 *      • "/src/**"   -> 相对于项目工作区根目录 (Project Root)
 *      • "./..." 或 "..." -> 相对工作区当前路径
 *
 * 3. 跨层级合并策略：
 *    Global (~/.pi/agent/approval-rules.json) 与 Project (<cwd>/.pi/approval-rules.json)
 *    以及 Session 规则做并集 (Union) 合并，Deny 规则绝对优先。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { stripLeadingEnvVars, tokenizeShellCommand } from "./shell-analyzer.ts";

export type DecisionType = "deny" | "ask" | "allow" | "default";

export interface PermissionRules {
	allow: string[];
	ask: string[];
	deny: string[];
	updatedAt?: string;
}

export interface ParsedRule {
	raw: string;
	toolName: string; // 宏名或真实工具名，如 "Read", "Bash", "edit"
	specifier?: string; // 括号内的参数规则，如 "/src/**", "git status"
	specifierKind: "command" | "path" | "generic";
}

export interface RuleMatchContext {
	cwd: string;
	toolName: string;
	input: Record<string, any>;
}

// 宏元分类映射表
const TOOL_MACROS: Record<string, string[]> = {
	read: ["read", "read_file", "grep", "grep_search", "glob", "list_directory", "zoom_image"],
	edit: ["edit", "write", "write_file", "notebook_edit"],
	bash: ["bash", "run_shell_command", "monitor"],
	shell: ["bash", "run_shell_command", "monitor"],
};

/**
 * 将工具名称标准化并展开宏
 */
function expandToolNames(targetTool: string): string[] {
	const lower = targetTool.toLowerCase();
	if (TOOL_MACROS[lower]) {
		return TOOL_MACROS[lower];
	}
	return [lower];
}

/**
 * 解析单条 DSL 规则字符串
 * 例如: "Bash(git *)", "Read(/src/**)", "Edit(.env*)", "Bash"
 */
export function parseDslRule(ruleStr: string): ParsedRule {
	const trimmed = ruleStr.trim();
	const match = trimmed.match(/^([a-zA-Z0-9_\-]+)(?:\((.*)\))?$/);

	if (!match) {
		return {
			raw: trimmed,
			toolName: trimmed,
			specifierKind: "generic",
		};
	}

	const toolName = match[1];
	const specifier = match[2]?.trim();

	const toolLower = toolName.toLowerCase();
	let specifierKind: "command" | "path" | "generic" = "generic";

	if (toolLower === "bash" || toolLower === "shell" || toolLower === "run_shell_command") {
		specifierKind = "command";
	} else if (
		toolLower === "read" ||
		toolLower === "readfile" ||
		toolLower === "read_file" ||
		toolLower === "edit" ||
		toolLower === "write" ||
		toolLower === "writefile" ||
		toolLower === "write_file"
	) {
		specifierKind = "path";
	}

	return {
		raw: trimmed,
		toolName,
		specifier: specifier !== undefined && specifier.length > 0 ? specifier : undefined,
		specifierKind,
	};
}

/**
 * 轻量且安全的 Glob 转正则表达式转换器
 * 支持:
 * - *  (单层匹配，不跨路径分隔符 /)
 * - ** (跨目录深度递归匹配)
 * - ?  (单字符)
 * - 默认匹配隐藏文件与点目录
 */
export function globToRegex(globPattern: string): RegExp {
	let regexStr = "^";
	let i = 0;
	const len = globPattern.length;

	while (i < len) {
		const c = globPattern[i];

		if (c === "*") {
			if (i + 1 < len && globPattern[i + 1] === "*") {
				// ** 处理
				i += 2;
				if (i < len && globPattern[i] === "/") {
					// **/ 匹配 0 个或多个目录层级
					i++;
					regexStr += "(?:.*\\/)?";
				} else {
					regexStr += ".*";
				}
				continue;
			}
			// 单个 * 匹配非斜杠字符
			regexStr += "[^\\/]*";
			i++;
			continue;
		}

		if (c === "?") {
			regexStr += "[^\\/]";
			i++;
			continue;
		}

		// 转义正则保留字
		if (/[.+^${}()|[\]\\]/.test(c)) {
			regexStr += `\\${c}`;
		} else {
			regexStr += c;
		}
		i++;
	}

	regexStr += "$";
	return new RegExp(regexStr);
}

/**
 * 匹配 Shell 命令通配符 (单词边界 + 环境变量剥离)
 */
export function matchesCommandPattern(commandStr: string, pattern: string): boolean {
	const rawCmd = commandStr.trim();
	const rawPat = pattern.trim();
	if (!rawCmd) return false;
	if (rawPat === "*") return true;

	// 1. 剥离目标命令的前导环境变量 (FOO=bar git status -> git status)
	const { tokens } = tokenizeShellCommand(rawCmd);
	const words = tokens.filter((t) => t.type === "word").map((t) => t.value);
	const { commandWords } = stripLeadingEnvVars(words);
	const normalizedCmd = commandWords.join(" ");

	// 2. 模式无通配符: 需严格单词边界匹配
	// 例如模式 "git" 匹配 "git"、"git status"，但不匹配 "gitk"
	if (!rawPat.includes("*")) {
		if (normalizedCmd === rawPat) return true;
		if (normalizedCmd.startsWith(`${rawPat} `)) return true;
		return false;
	}

	// 3. 模式含通配符: 编译为精确正则
	// "git *" -> /^git( .*)?$/
	// "npm test*" -> /^npm test.*$/
	let regexStr = "^";
	for (let i = 0; i < rawPat.length; i++) {
		const c = rawPat[i];
		if (c === "*") {
			if (i > 0 && rawPat[i - 1] === " ") {
				// 匹配 "git *" 结构
				regexStr = regexStr.slice(0, -1); // 移除前面的空格
				regexStr += "(?: .*)?";
			} else {
				regexStr += ".*";
			}
		} else if (/[.+^${}()|[\]\\]/.test(c)) {
			regexStr += `\\${c}`;
		} else {
			regexStr += c;
		}
	}
	regexStr += "$";

	const reg = new RegExp(regexStr);
	return reg.test(normalizedCmd) || reg.test(rawCmd);
}

/**
 * 匹配路径通配符 (支持 //, ~/, /, ./ 作用域前缀及 Glob)
 */
export function matchesPathPattern(targetPath: string, pattern: string, cwd: string): boolean {
	const normTarget = normalize(targetPath).replace(/\\/g, "/");
	const normPattern = pattern.trim().replace(/\\/g, "/");
	const home = homedir().replace(/\\/g, "/");
	const projectRoot = normalize(cwd).replace(/\\/g, "/");

	// 1. 计算目标文件的物理绝对路径
	let absTarget: string;
	if (isAbsolute(normTarget)) {
		absTarget = normTarget;
	} else {
		absTarget = normalize(join(cwd, normTarget)).replace(/\\/g, "/");
	}

	// 目标文件相对于工作区根目录的相对路径 (如 src/index.ts)
	let relTarget = relative(projectRoot, absTarget).replace(/\\/g, "/");
	if (relTarget.startsWith("./")) relTarget = relTarget.slice(2);

	// 2. 解析 pattern 作用域并比对
	// 作用域 A: //... (文件系统绝对根，如 //etc/**)
	if (normPattern.startsWith("//")) {
		const absPattern = normPattern.slice(1); // 变为 /etc/**
		const reg = globToRegex(absPattern);
		return reg.test(absTarget);
	}

	// 作用域 B: ~/... (相对于用户主目录，如 ~/.ssh/**)
	if (normPattern.startsWith("~/")) {
		const absPattern = join(home, normPattern.slice(2)).replace(/\\/g, "/");
		const reg = globToRegex(absPattern);
		return reg.test(absTarget);
	}

	// 作用域 C: /... (相对于项目工作区根目录，如 /src/**, /package.json)
	if (normPattern.startsWith("/")) {
		const patternRel = normPattern.slice(1); // 变为 src/**
		const reg = globToRegex(patternRel);
		// 同时测试相对路径与带斜杠相对路径
		return reg.test(relTarget) || reg.test(`/${relTarget}`);
	}

	// 作用域 D: ./... 或 普通文件名/通配符 (如 .env*, src/**, README.md)
	let cleanPattern = normPattern;
	if (cleanPattern.startsWith("./")) cleanPattern = cleanPattern.slice(2);

	const reg = globToRegex(cleanPattern);
	// 1) 直接匹配相对工作区路径 (src/index.ts)
	if (reg.test(relTarget)) return true;
	// 2) 匹配纯文件名 (例如规则为 ".env*" 时匹配任意目录下的 ".env.local")
	const fileName = absTarget.split("/").pop() || "";
	if (reg.test(fileName)) return true;

	return false;
}

/**
 * 校验单条 ParsedRule 是否匹配当前调用上下文
 */
export function matchesParsedRule(rule: ParsedRule, ctx: RuleMatchContext): boolean {
	const candidateTools = expandToolNames(rule.toolName);
	const targetToolLower = ctx.toolName.toLowerCase();

	if (!candidateTools.includes(targetToolLower)) {
		return false;
	}

	// 全工具放行/拒绝 (未提供 specifier 括号)
	if (!rule.specifier) {
		return true;
	}

	const spec = rule.specifier;

	// 1. 命令模式 (Bash)
	if (rule.specifierKind === "command") {
		const commandStr = (ctx.input.command || "").trim();
		return matchesCommandPattern(commandStr, spec);
	}

	// 2. 路径模式 (Read / Edit)
	if (rule.specifierKind === "path") {
		const pathStr = (ctx.input.path || ctx.input.file_path || "").trim();
		if (!pathStr) return false;
		return matchesPathPattern(pathStr, spec, ctx.cwd);
	}

	// 3. 通用模式
	const inputStr = JSON.stringify(ctx.input);
	return inputStr.includes(spec);
}

/**
 * 权限规则管理器 (PermissionManager)
 */
export class PermissionManager {
	private cwd: string;
	private sessionRules: PermissionRules = { allow: [], ask: [], deny: [] };
	private projectRules: PermissionRules = { allow: [], ask: [], deny: [] };
	private userRules: PermissionRules = { allow: [], ask: [], deny: [] };

	constructor(cwd: string) {
		this.cwd = cwd;
		this.reloadAll();
	}

	public reloadAll(): void {
		this.projectRules = this.loadRulesFromFile(join(this.cwd, ".pi", "approval-rules.json"));
		this.userRules = this.loadRulesFromFile(join(homedir(), ".pi", "agent", "approval-rules.json"));
	}

	public getSessionRules(): PermissionRules {
		return this.sessionRules;
	}

	public getProjectRules(): PermissionRules {
		return this.projectRules;
	}

	public getUserRules(): PermissionRules {
		return this.userRules;
	}

	public clearSessionRules(): void {
		this.sessionRules = { allow: [], ask: [], deny: [] };
	}

	public clearProjectRules(): void {
		this.projectRules = { allow: [], ask: [], deny: [] };
		this.saveRulesToFile(join(this.cwd, ".pi", "approval-rules.json"), this.projectRules);
	}

	public clearUserRules(): void {
		this.userRules = { allow: [], ask: [], deny: [] };
		this.saveRulesToFile(join(homedir(), ".pi", "agent", "approval-rules.json"), this.userRules);
	}

	/**
	 * 添加规则到指定作用域
	 */
	public addRule(
		type: "allow" | "ask" | "deny",
		ruleStr: string,
		scope: "session" | "project" | "user",
	): void {
		const trimmed = ruleStr.trim();
		if (!trimmed) return;

		if (scope === "session") {
			if (!this.sessionRules[type].includes(trimmed)) {
				this.sessionRules[type].push(trimmed);
			}
		} else if (scope === "project") {
			if (!this.projectRules[type].includes(trimmed)) {
				this.projectRules[type].push(trimmed);
				this.saveRulesToFile(join(this.cwd, ".pi", "approval-rules.json"), this.projectRules);
			}
		} else if (scope === "user") {
			if (!this.userRules[type].includes(trimmed)) {
				this.userRules[type].push(trimmed);
				this.saveRulesToFile(join(homedir(), ".pi", "agent", "approval-rules.json"), this.userRules);
			}
		}
	}

	/**
	 * 核心状态机决策求值：
	 * Deny (3) > Ask (2) > Allow (0) > Default
	 */
	public evaluate(ctx: RuleMatchContext): { decision: DecisionType; matchedRule?: string } {
		// 聚合所有层级的规则 (Union 并集)
		const allDeny = [
			...this.sessionRules.deny,
			...this.projectRules.deny,
			...this.userRules.deny,
		];
		const allAsk = [
			...this.sessionRules.ask,
			...this.projectRules.ask,
			...this.userRules.ask,
		];
		const allAllow = [
			...this.sessionRules.allow,
			...this.projectRules.allow,
			...this.userRules.allow,
		];

		// 1. 扫描 Deny 规则池 (最高优先级，短路阻断)
		for (const r of allDeny) {
			const parsed = parseDslRule(r);
			if (matchesParsedRule(parsed, ctx)) {
				return { decision: "deny", matchedRule: r };
			}
		}

		// 2. 扫描 Ask 规则池 (次高优先级，强制人工确认)
		for (const r of allAsk) {
			const parsed = parseDslRule(r);
			if (matchesParsedRule(parsed, ctx)) {
				return { decision: "ask", matchedRule: r };
			}
		}

		// 3. 扫描 Allow 规则池 (免审通过)
		for (const r of allAllow) {
			const parsed = parseDslRule(r);
			if (matchesParsedRule(parsed, ctx)) {
				return { decision: "allow", matchedRule: r };
			}
		}

		// 4. 未命中显式预设规则，返回 default
		return { decision: "default" };
	}

	/**
	 * 从文件读取并规范化规则格式 (无缝兼容旧版本的纯字符串数组)
	 */
	private loadRulesFromFile(filePath: string): PermissionRules {
		const empty: PermissionRules = { allow: [], ask: [], deny: [] };
		if (!existsSync(filePath)) return empty;

		try {
			const raw = readFileSync(filePath, "utf-8");
			const data = JSON.parse(raw);

			// 兼容旧格式 { allow: string[] }
			const allow = Array.isArray(data.allow)
				? data.allow.filter((x: any) => typeof x === "string" && x.trim().length > 0)
				: [];
			const ask = Array.isArray(data.ask)
				? data.ask.filter((x: any) => typeof x === "string" && x.trim().length > 0)
				: [];
			const deny = Array.isArray(data.deny)
				? data.deny.filter((x: any) => typeof x === "string" && x.trim().length > 0)
				: [];

			return { allow, ask, deny, updatedAt: data.updatedAt };
		} catch {
			return empty;
		}
	}

	/**
	 * 保存规则到文件
	 */
	private saveRulesToFile(filePath: string, rules: PermissionRules): void {
		try {
			const dir = dirname(filePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			const data = {
				allow: Array.from(new Set(rules.allow)),
				ask: Array.from(new Set(rules.ask)),
				deny: Array.from(new Set(rules.deny)),
				updatedAt: new Date().toISOString(),
			};
			writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error(`[permission-engine] 保存规则失败 (${filePath}):`, err);
		}
	}
}
