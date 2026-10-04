/**
 * Permission Engine and DSL Rule Matcher
 *
 * 对齐 Qwen Code 的四态权限规则控制体系与 DSL 语法引擎：
 *
 * 1. 四态判定优先级：
 *    Deny (3, 最高) > Ask (2) > Default (1) > Allow (0)
 *    - deny: 运行时直接阻断，向模型返回错误原因，不触发用户弹窗；
 *    - ask:  强制挂起并弹窗要求用户确认，压倒 allow；
 *    - default: 显式 default 规则命中，或未命中任何规则 → 交给审批模式漏斗（auto→classifier、非交互拒绝）；
 *    - allow: 免审放行（受 auto 模式高危暂存保护）；
 *    （读类工具未命中规则时，再经工具默认权限层：工作区内 allow / 工作区外 ask）
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

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { stripLeadingEnvVars, tokenizeShellCommand } from "./shell-analyzer.ts";

export type DecisionType = "deny" | "ask" | "allow" | "default";

/** 规则四态类型（allow / ask / default / deny）。 */
export type RuleVerdict = "allow" | "ask" | "deny" | "default";

export interface PermissionRules {
	allow: string[];
	ask: string[];
	deny: string[];
	default: string[];
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
	read: ["read", "read_file", "grep", "grep_search", "find", "ls", "glob", "list_directory", "zoom_image"],
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
	const match = trimmed.match(/^([a-zA-Z0-9_-]+)(?:\((.*)\))?$/);

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

	// 1. 计算目标文件的物理绝对路径（`~` 与 pattern 侧同样展开，保证往返匹配）
	let absTarget: string;
	const expandedTarget = expandTilde(normTarget);
	if (isAbsolute(expandedTarget)) {
		absTarget = expandedTarget;
	} else {
		absTarget = normalize(join(cwd, expandedTarget)).replace(/\\/g, "/");
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

export interface ConflictCheckResult {
	hasConflict: boolean;
	/** auto 模式不变量：危险 allow 规则在暂存态下被拦截入暂存池（不激活、不参与匹配）。 */
	stashed?: boolean;
	shadowedBy?: {
		scope: "session" | "project" | "user";
		verdict: "deny" | "ask" | "default";
		rule: string;
	};
	shadowsExisting?: {
		scope: "session" | "project" | "user";
		verdict: "allow" | "default" | "ask";
		rule: string;
	};
	warning?: string;
}

export function formatScopeName(scope: "session" | "project" | "user"): string {
	switch (scope) {
		case "session":
			return "会话层";
		case "project":
			return "项目层";
		case "user":
			return "用户层";
	}
}

/**
 * 判断两条 DSL 规则在语义上是否覆盖或冲突
 */
export function rulesOverlap(ruleA: ParsedRule, ruleB: ParsedRule, cwd: string): boolean {
	const toolsA = expandToolNames(ruleA.toolName);
	const toolsB = expandToolNames(ruleB.toolName);
	const commonTools = toolsA.filter((t) => toolsB.includes(t));
	if (commonTools.length === 0) return false;

	// 若某一条无 specifier 或为 *，则代表匹配该工具的所有操作
	if (!ruleA.specifier || ruleA.specifier === "*" || !ruleB.specifier || ruleB.specifier === "*") {
		return true;
	}

	const specA = ruleA.specifier.trim();
	const specB = ruleB.specifier.trim();

	if (specA === specB) return true;

	if (ruleA.specifierKind === "command" && ruleB.specifierKind === "command") {
		return matchesCommandPattern(specA, specB) || matchesCommandPattern(specB, specA);
	}

	if (ruleA.specifierKind === "path" && ruleB.specifierKind === "path") {
		return matchesPathPattern(specA, specB, cwd) || matchesPathPattern(specB, specA, cwd);
	}

	return false;
}

/**
 * 权限规则管理器 (PermissionManager)
 */
export class PermissionManager {
	private cwd: string;
	private userDir: string;
	private isTrusted: boolean = true;
	private projectRulesBlocked: boolean = false;
	private sessionRules: PermissionRules = { allow: [], ask: [], deny: [], default: [] };
	private projectRules: PermissionRules = { allow: [], ask: [], deny: [], default: [] };
	private userRules: PermissionRules = { allow: [], ask: [], deny: [], default: [] };
	/** auto 模式下暂存的危险 allow 规则（null = 未处于暂存态）。运行时专用：磁盘规则文件保留这些规则，退出 auto 恢复。 */
	private strippedAllowRules: Array<{ scope: "session" | "project" | "user"; rule: string }> | null = null;

	constructor(cwd: string, userDir?: string, initialSessionRules?: PermissionRules, isTrusted = true) {
		this.cwd = cwd;
		this.userDir = userDir || join(homedir(), ".pi", "agent");
		this.isTrusted = isTrusted;
		if (initialSessionRules) {
			this.sessionRules = {
				allow: [...initialSessionRules.allow],
				ask: [...initialSessionRules.ask],
				deny: [...initialSessionRules.deny],
				default: [...(initialSessionRules.default ?? [])],
			};
		}
		this.reloadAll();
	}

	public setIsTrusted(isTrusted: boolean): void {
		this.isTrusted = isTrusted;
		this.reloadAll();
	}

	public getIsTrusted(): boolean {
		return this.isTrusted;
	}

	public isProjectRulesBlocked(): boolean {
		return this.projectRulesBlocked;
	}

	/**
	 * 重新加载磁盘规则文件（项目级与用户全局），保留内存态 sessionRules
	 */
	public reloadFiles(): void {
		this.reloadAll();
	}

	public reloadAll(): void {
		const projectRuleFile = join(this.cwd, ".pi", "approval-rules.json");
		if (this.isTrusted) {
			this.projectRules = this.loadRulesFromFile(projectRuleFile);
			this.projectRulesBlocked = false;
		} else {
			this.projectRules = { allow: [], ask: [], deny: [], default: [] };
			this.projectRulesBlocked = existsSync(projectRuleFile);
		}
		this.userRules = this.loadRulesFromFile(join(this.userDir, "approval-rules.json"));
		this.reassertAutoStashOnLoadedRules();
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
		if (this.strippedAllowRules) {
			this.strippedAllowRules = this.strippedAllowRules.filter((s) => s.scope !== "session");
		}
		this.sessionRules = { allow: [], ask: [], deny: [], default: [] };
	}

	public clearProjectRules(): void {
		if (this.strippedAllowRules) {
			this.strippedAllowRules = this.strippedAllowRules.filter((s) => s.scope !== "project");
		}
		this.projectRules = { allow: [], ask: [], deny: [], default: [] };
		if (this.isTrusted) {
			this.saveRulesToFile(join(this.cwd, ".pi", "approval-rules.json"), this.projectRules);
		}
	}

	public clearUserRules(): void {
		if (this.strippedAllowRules) {
			this.strippedAllowRules = this.strippedAllowRules.filter((s) => s.scope !== "user");
		}
		this.userRules = { allow: [], ask: [], deny: [], default: [] };
		this.saveRulesToFile(join(this.userDir, "approval-rules.json"), this.userRules);
	}

	// ==============================================================
	// AUTO 模式危险 allow 规则暂存
	// （对齐 qwen-code stripDangerousRulesForAutoMode 语义：
	//   进入 auto 剥离、退出恢复、暂存态新增同拦、运行时专用不改磁盘意图）
	// ==============================================================

	/** 返回当前暂存的危险 allow 规则快照（供 /approval-rules 展示）。 */
	public getStashedAllowRules(): Array<{ scope: "session" | "project" | "user"; rule: string }> {
		return this.strippedAllowRules ? [...this.strippedAllowRules] : [];
	}

	/**
	 * 进入 auto：把宽到足以绕过分类器的 allow 规则移出工作池暂存。幂等。
	 * @returns 本次被暂存的规则清单（已处于暂存态时为空数组）
	 */
	public stripDangerousAllowRulesForAuto(): string[] {
		if (this.strippedAllowRules) return [];
		this.strippedAllowRules = [];
		return this.stashDangerousAllowRules();
	}

	/**
	 * auto 暂存态下的加载一致性收口：
	 * 磁盘规则文件本就保留暂存规则（persistRules 合成），因此 reloadAll 整表重载会把它们带回工作池并
	 * 参与 evaluate()——出现"界面显示已暂存、实际已生效"的危险不一致。任何加载路径
	 * （/approval-rules、/reload、setIsTrusted 信任闸）重载后都必须重新摘除，并与既有暂存池去重合并。
	 */
	private reassertAutoStashOnLoadedRules(): void {
		if (this.strippedAllowRules === null) return;
		this.stashDangerousAllowRules();
	}

	/**
	 * 把三层工作池中的危险 allow 规则摘除并入暂存池（按 scope+rule 去重，故可重复调用）。
	 * @returns 本次从工作池摘除的规则清单
	 */
	private stashDangerousAllowRules(): string[] {
		const stash = this.strippedAllowRules;
		if (stash === null) return [];
		const stripped: string[] = [];
		const scopes: Array<{ scope: "session" | "project" | "user"; rules: PermissionRules }> = [
			{ scope: "session", rules: this.sessionRules },
			{ scope: "project", rules: this.projectRules },
			{ scope: "user", rules: this.userRules },
		];
		for (const { scope, rules } of scopes) {
			const moved = rules.allow.filter((r) => isDangerousAllowRule(r));
			if (moved.length === 0) continue;
			rules.allow = rules.allow.filter((r) => !isDangerousAllowRule(r));
			for (const rule of moved) {
				if (!stash.some((s) => s.scope === scope && s.rule === rule)) {
					stash.push({ scope, rule });
				}
				stripped.push(rule);
			}
		}
		return stripped;
	}

	/** 退出 auto：暂存的危险 allow 规则原样归位（磁盘文件本就保留，仅内存态恢复）。 */
	public restoreDangerousAllowRules(): void {
		if (!this.strippedAllowRules) return;
		for (const { scope, rule } of this.strippedAllowRules) {
			const target =
				scope === "session" ? this.sessionRules : scope === "project" ? this.projectRules : this.userRules;
			if (!target.allow.includes(rule)) target.allow.push(rule);
		}
		this.strippedAllowRules = null;
	}

	/** 持久化某层规则：磁盘 = 内存工作池 + 该层暂存规则（保证暂存规则不被后续写入冲掉）。 */
	private persistRules(scope: "project" | "user"): void {
		const base = scope === "project" ? this.projectRules : this.userRules;
		const stashedForScope = (this.strippedAllowRules ?? [])
			.filter((s) => s.scope === scope && !base.allow.includes(s.rule))
			.map((s) => s.rule);
		const next: PermissionRules = stashedForScope.length
			? { ...base, allow: [...base.allow, ...stashedForScope] }
			: base;
		const filePath =
			scope === "project" ? join(this.cwd, ".pi", "approval-rules.json") : join(this.userDir, "approval-rules.json");
		this.saveRulesToFile(filePath, next);
	}

	/**
	 * 检查某条规则是否存在跨层冲突/压死
	 */
	public checkConflict(
		type: RuleVerdict,
		ruleStr: string,
		_scope: "session" | "project" | "user",
	): ConflictCheckResult {
		const trimmed = ruleStr.trim();
		if (!trimmed) return { hasConflict: false };

		const newParsed = parseDslRule(trimmed);
		const severityMap: Record<RuleVerdict, number> = {
			allow: 0,
			default: 1,
			ask: 2,
			deny: 3,
		};
		const newSeverity = severityMap[type];

		const allScopes: Array<{ scope: "session" | "project" | "user"; rules: PermissionRules }> = [
			{ scope: "session", rules: this.sessionRules },
			{ scope: "project", rules: this.projectRules },
			{ scope: "user", rules: this.userRules },
		];

		// 1. 检查是否被更高优先级的规则压死 (Stricter shadow)
		for (const s of allScopes) {
			for (const verdict of ["deny", "ask", "default"] as const) {
				if (severityMap[verdict] > newSeverity) {
					for (const existingRule of s.rules[verdict]) {
						const existingParsed = parseDslRule(existingRule);
						if (rulesOverlap(newParsed, existingParsed, this.cwd)) {
							return {
								hasConflict: true,
								shadowedBy: {
									scope: s.scope,
									verdict,
									rule: existingRule,
								},
								warning: `⚠️ 该 ${type} 规则将被${formatScopeName(s.scope)} ${verdict} 压死（${existingRule}），本条不会生效。`,
							};
						}
					}
				}
			}
		}

		// 2. 检查本条规则是否会压死其他层级已有的更弱规则 (Shadows weaker existing)
		for (const s of allScopes) {
			if (s.scope === _scope) continue; // 同层忽略
			for (const verdict of ["default", "ask", "allow"] as const) {
				if (severityMap[verdict] < newSeverity) {
					for (const existingRule of s.rules[verdict]) {
						const existingParsed = parseDslRule(existingRule);
						if (rulesOverlap(newParsed, existingParsed, this.cwd)) {
							return {
								hasConflict: true,
								shadowsExisting: {
									scope: s.scope,
									verdict,
									rule: existingRule,
								},
								warning: `⚠️ 新增的 ${type} 规则将压死现有的${formatScopeName(s.scope)} ${verdict} 规则（${existingRule}）。`,
							};
						}
					}
				}
			}
		}

		return { hasConflict: false };
	}

	/**
	 * 添加规则到指定作用域（附带跨层冲突检测）
	 */
	public addRule(
		type: RuleVerdict,
		ruleStr: string,
		scope: "session" | "project" | "user",
	): ConflictCheckResult {
		const trimmed = ruleStr.trim();
		if (!trimmed) return { hasConflict: false };

		if (scope === "project" && !this.isTrusted) {
			return {
				hasConflict: false,
				warning: `⚠️ 当前工作区未受信任，项目级规则加载与持久化已禁用。请使用 --approve 信任项目。`,
			};
		}

		// auto 模式不变量：暂存态下新增的危险 allow 规则入暂存池，不激活。
		// 持久层（project/user）磁盘照常写入（persistRules 合成暂存），退出 auto 恢复。
		if (type === "allow" && this.strippedAllowRules !== null && isDangerousAllowRule(trimmed)) {
			this.strippedAllowRules.push({ scope, rule: trimmed });
			if (scope === "project") this.persistRules("project");
			if (scope === "user") this.persistRules("user");
			return { hasConflict: false, stashed: true };
		}

		const conflict = this.checkConflict(type, trimmed, scope);

		if (scope === "session") {
			if (!this.sessionRules[type].includes(trimmed)) {
				this.sessionRules[type].push(trimmed);
			}
		} else if (scope === "project") {
			if (!this.projectRules[type].includes(trimmed)) {
				this.projectRules[type].push(trimmed);
				this.persistRules("project");
			}
		} else if (scope === "user") {
			if (!this.userRules[type].includes(trimmed)) {
				this.userRules[type].push(trimmed);
				this.persistRules("user");
			}
		}

		return conflict;
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
		const allDefault = [
			...this.sessionRules.default,
			...this.projectRules.default,
			...this.userRules.default,
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

		// 2.5 扫描 default 规则池 (交给审批模式：auto→classifier，非 auto→人工)
		for (const r of allDefault) {
			const parsed = parseDslRule(r);
			if (matchesParsedRule(parsed, ctx)) {
				return { decision: "default", matchedRule: r };
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
		const empty: PermissionRules = { allow: [], ask: [], deny: [], default: [] };
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
			const def = Array.isArray(data.default)
				? data.default.filter((x: any) => typeof x === "string" && x.trim().length > 0)
				: [];

			return { allow, ask, deny, default: def, updatedAt: data.updatedAt };
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
				default: Array.from(new Set(rules.default)),
				updatedAt: new Date().toISOString(),
			};
			writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error(`[permission-engine] 保存规则失败 (${filePath}):`, err);
		}
	}
}

// ==============================================================
// 工具默认权限层
// ==============================================================

/** 读类工具集合（pi 实际内置的只读工具）。 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** 判断是否为读类工具（需要工具默认权限层）。 */
export function isReadOnlyTool(toolName: string): boolean {
	return READ_ONLY_TOOLS.has(toolName.toLowerCase());
}

/** 读类工具模式漏斗处置档位。 */
export type ModeFunnelDisposition = "allow" | "classifier" | "prompt";

/**
 * 读类工具（命中 default 规则）在各审批模式下的漏斗处置矩阵：
 *
 * | 模式           | 处置                                    |
 * |----------------|-----------------------------------------|
 * | yolo           | 放行                                    |
 * | plan           | 放行（plan 只读语义）                   |
 * | auto           | classifier（交互不通过转人工、非交互拒绝）|
 * | auto-edit / manual | 人工确认                           |
 *
 * 纯函数，独立于 pi 运行时，便于单测验收处置矩阵。
 */
export function resolveReadDisposition(mode: string): ModeFunnelDisposition {
	switch (mode) {
		case "yolo":
		case "plan":
			return "allow";
		case "auto":
			return "classifier";
		default:
			return "prompt";
	}
}

// ==============================================================
// AUTO 模式危险 allow 判据
// （对齐 qwen-code dangerousRules.ts：解释器裸规则/通配规则会绕过分类器；
//   具体命令如 `Bash(npm test)` 是用户明确信任的，不剥离）
// ==============================================================

/** 裸首命令即任意代码执行入口的 token 集（Unix/Windows shell、脚本解释器、
 * 构建/包工具、包运行器、远程 shell、eval 类）。对齐 qwen-code 同名清单。 */
const DANGEROUS_BASH_INTERPRETERS: readonly string[] = Object.freeze([
	"bash", "sh", "zsh", "fish", "csh", "tcsh", "dash", "ksh",
	"cmd", "pwsh", "powershell",
	"python", "python3", "python2", "node", "deno", "tsx", "bun", "ruby", "perl", "php", "lua",
	"julia", "r", "rscript", "groovy", "awk", "gawk",
	"cargo", "npm", "pnpm", "yarn", "make", "gmake", "gradle", "mvn", "rake", "task", "just", "go",
	"npx", "bunx", "pnpx", "uvx", "pipx", "dlx",
	"ssh", "eval", "exec", "source",
]);

function stripExeSuffix(token: string): string {
	return token.endsWith(".exe") ? token.slice(0, -".exe".length) : token;
}

function matcherColonIndex(content: string): number {
	const firstColon = content.indexOf(":");
	if (firstColon < 0) return -1;
	if (/^[a-z]:[\\/]/i.test(content)) return content.indexOf(":", 2);
	return firstColon;
}

function leadingCommandToken(content: string): string {
	if (/^[a-z]:[\\/]/i.test(content)) {
		const exeIndex = content.indexOf(".exe");
		if (exeIndex >= 0) return content.slice(0, exeIndex + ".exe".length);
	}
	return content.split(/\s/)[0] ?? "";
}

/** 首命令 token 是否解释器（支持裸名、绝对路径、尾通配、冒号、 .exe 后缀）。 */
function isInterpreterToken(rawToken: string): boolean {
	if (!rawToken) return false;
	let end = rawToken.length;
	while (end > 0 && rawToken.charCodeAt(end - 1) === 42 /* '*' */) end--;
	const noWildcard = rawToken.slice(0, end);
	const colonIndex = matcherColonIndex(noWildcard);
	const beforeColon = colonIndex >= 0 ? noWildcard.slice(0, colonIndex) : noWildcard;
	const lastSegment = beforeColon.split(/[\\/]/).pop() ?? "";
	const normalizedSegment = stripExeSuffix(lastSegment);
	return DANGEROUS_BASH_INTERPRETERS.some((i) => stripExeSuffix(i) === normalizedSegment);
}

/**
 * 判定一条 allow 规则是否宽到足以绕过 auto 分类器：
 * - shell 族工具（bash / run_shell_command / monitor，含 Bash 宏展开）：
 *   裸规则、`*`、解释器裸名、解释器×任意通配（`python *`、`npx *`、`/usr/bin/python3 *`）→ 危险；
 * - 具体命令（`Bash(git status)`、`Bash(npm test)`、`Bash(python script.py)`）→ 用户明确信任，不剥离；
 * - 非 shell 族（Read/Edit 等）→ 本判据不适用，返回 false。
 *
 * 注：qwen-code 同源清单还含 Agent/Skill 工具类（子代理/技能执行绕过分类器），
 * pi 工具集无对应项，待 pi 出现同类工具时再行对齐（见 task 记录）。
 */
export function isDangerousAllowRule(ruleStr: string): boolean {
	const parsed = parseDslRule(ruleStr);
	const tools = expandToolNames(parsed.toolName);
	const isShellLike = tools.some((t) => t === "bash" || t === "run_shell_command" || t === "monitor");
	if (!isShellLike) return false;

	if (!parsed.specifier) return true;
	const content = parsed.specifier.trim().toLowerCase();
	if (content === "" || content === "*") return true;

	const firstToken = leadingCommandToken(content);
	if (!isInterpreterToken(firstToken)) return false;

	// 解释器裸名（`Bash(python)`）→ 危险
	if (firstToken === content && matcherColonIndex(content) < 0) return true;
	// 解释器 × 任意通配（`python *`、`node -e *`、`npx *`）→ 危险
	if (content.includes("*")) return true;
	// 冒号匹配器形式：仅空后缀（`python:`）危险，具体子命令不剥离
	const colonIndex = matcherColonIndex(content);
	if (colonIndex >= 0) return content.slice(colonIndex + 1).trim() === "";
	// 多词具体命令（`npm test`、`python script.py`）→ 具体信任，不剥离
	return false;
}

/** 展开路径中的 `~` / `~/`（规则与目标两侧统一使用，保证往返匹配）。 */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return p;
}

/**
 * 为读类调用生成可往返匹配的 DSL 规则（审批弹窗「记住」用）：
 * - 绝对路径 → `//...`（文件系统绝对根作用域）
 * - `~` / `~/...` → 原样（家目录作用域，匹配时目标同步展开）
 * - 相对路径 → 原样（工作区相对作用域）
 */
export function buildReadDslRule(targetPath: string): string {
	const raw = (targetPath || "").trim();
	if (!raw) return "Read(*)";
	if (raw === "~") return `Read(//${homedir()})`;
	if (raw.startsWith("~/") || raw.startsWith("~\\")) return `Read(${raw})`;
	if (isAbsolute(raw)) return `Read(//${raw.replace(/^[\\/]+/, "")})`;
	return `Read(${raw})`;
}

/**
 * 解析真实路径（跟随符号链接与内核 `..` 语义）；解析失败（路径不存在等）返回 null。
 * 白名单匹配必须同时防 `../` 穿越与符号链接逃逸——能解析的按真实位置判，
 * 无法解析的路径读取必然失败，回退词法匹配维持既有行为。
 */
function realpathOrNull(p: string): string | null {
	try {
		return normalize(realpathSync(p)).replace(/\\/g, "/");
	} catch {
		return null;
	}
}

/**
 * 工具默认权限：内建的保守安全基线，在用户规则之后、审批模式之前生效。
 *
 * 读类工具（read/grep/find/ls）：工作区内 `allow`，工作区外 `ask`（对齐 qwen-code）。
 * 其余工具返回 `allow`（交给现有审批模式兑底，不在此层额外收紧）。
 *
 * @param toolName   工具名
 * @param targetPath 目标路径（读类工具的 path 参数；无则为空串）
 * @param cwd        当前工作目录
 */
export function getToolDefaultPermission(
	toolName: string,
	targetPath: string,
	cwd: string,
	isProjectTrusted: boolean = true,
): "allow" | "ask" {
	const lower = toolName.toLowerCase();
	if (!READ_ONLY_TOOLS.has(lower)) {
		return "allow";
	}

	const raw = (targetPath || "").trim();
	if (!raw) {
		// 无显式目标路径（如 grep/find/ls 默认当前目录）→ 工作区内
		return "allow";
	}

	// 展开 `~`（验收要求：read ~/.ssh/id_rsa 应判为区外）
	const expanded = expandTilde(raw);

	let abs: string;
	if (isAbsolute(expanded)) {
		abs = normalize(expanded).replace(/\\/g, "/");
	} else {
		abs = normalize(join(cwd, expanded)).replace(/\\/g, "/");
	}

	// 白名单先归一化、再按真实路径判（realpath 跟随符号链接，防逃逸）
	const rawAbs = isAbsolute(expanded) ? expanded : join(cwd, expanded);
	const realAbs = realpathOrNull(rawAbs);
	const underWhitelist = (dirLexical: string): boolean => {
		if (realAbs !== null) {
			const realDir = realpathOrNull(dirLexical) ?? dirLexical;
			return realAbs === realDir || realAbs.startsWith(realDir + "/");
		}
		return abs === dirLexical || abs.startsWith(dirLexical + "/");
	};

	// 1. 恒豁免用户级 skill 目录
	const userSkillDir1 = normalize(join(homedir(), ".pi/agent/skills")).replace(/\\/g, "/");
	const userSkillDir2 = normalize(join(homedir(), ".agents/skills")).replace(/\\/g, "/");
	if (underWhitelist(userSkillDir1) || underWhitelist(userSkillDir2)) {
		return "allow";
	}

	// 2. 项目受信时，豁免 cwd 及其祖先目录中的项目级 skill 目录
	if (isProjectTrusted) {
		let current = normalize(cwd).replace(/\\/g, "/");
		while (true) {
			const projSkillDir1 = normalize(join(current, ".pi/skills")).replace(/\\/g, "/");
			const projSkillDir2 = normalize(join(current, ".agents/skills")).replace(/\\/g, "/");
			
			if (underWhitelist(projSkillDir1) || underWhitelist(projSkillDir2)) {
				return "allow";
			}
			
			const parent = normalize(join(current, "..")).replace(/\\/g, "/");
			if (parent === current) break;
			current = parent;
		}
	}

	// 工作区内外同样按真实路径判（realpath 可解析时）：防符号链接从区内逃逸到区外读取
	// （I3 / Claude Code acceptEdits 先例；realpath 失败=路径不存在=读取必失败，回退词法行为不变）
	const realCwd = realAbs !== null ? realpathOrNull(cwd) : null;
	const root = realCwd ?? normalize(cwd).replace(/\\/g, "/");
	const subject = realAbs ?? abs;

	const rel = relative(root, subject).replace(/\\/g, "/");
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
		return "allow";
	}
	return "ask";
}
