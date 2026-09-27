/**
 * Shell Command Lexer and Safety Analyzer
 *
 * 工业级 Shell 命令安全解析器，拒绝玩具级前缀正则匹配。
 *
 * 核心安全防御机制：
 * 1. 词法状态机 (Lexer)：精准识别单双引号、转义字符，隔离变量与字面量；
 * 2. 复合命令分段 (Compound Splitting)：拆解 '&&', '||', ';', '&'，严防多语句注入逃逸；
 * 3. 管道安全校验 (Pipeline Inspection)：管道末端仅放行安全只读过滤器 (grep, wc, head, tail 等)；
 * 4. 写入重定向阻断 (Redirection Guard)：凡检测到 '>', '>>', '&>', '1>file', '2>file' 立即一票否决；
 * 5. 命令替换与子 Shell 防御：严防 '$()', '`...`', '<()', '>()' 动态提权；
 * 6. 参数级深度守卫 (Flag Guarding)：
 *    - find: 严禁 -exec, -execdir, -ok, -okdir, -delete
 *    - git: 仅放行 status, diff, log, show 等安全只读子命令，严防 push, commit, checkout, branch -d
 *    - sed / perl: 严禁 -i, --in-place
 *    - 阻断 tee, xargs 等任意执行/写操作命令
 */

export interface ShellAnalysisResult {
	isReadOnly: boolean;
	hasWriteRedirection: boolean;
	hasCommandSubstitution: boolean;
	hasDangerousFlag: boolean;
	reason?: string;
	detectedCommands: string[];
}

// 纯只读命令（无副作用的单命令本体）
const SAFE_READ_ONLY_BINARIES = new Set([
	"ls",
	"ll",
	"la",
	"pwd",
	"cat",
	"head",
	"tail",
	"more",
	"less",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"find",
	"fd",
	"which",
	"whereis",
	"whoami",
	"uname",
	"wc",
	"diff",
	"colordiff",
	"file",
	"stat",
	"tree",
	"echo",
	"printf",
	"true",
	"false",
	"test",
	"expr",
	"env",
	"printenv",
	"date",
	"cal",
	"uptime",
	"hostname",
	"id",
	"groups",
	"ps",
	"top",
	"htop",
	"df",
	"du",
	"free",
	"git",
	"npm",
	"pnpm",
	"yarn",
	"cargo",
	"go",
	"python",
	"python3",
	"node",
	"ruby",
	"rustc",
	"gcc",
	"g++",
	"clang",
]);

// 允许在管道下游充当过滤器的命令
const SAFE_PIPE_FILTERS = new Set([
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"wc",
	"head",
	"tail",
	"less",
	"more",
	"sort",
	"uniq",
	"cut",
	"tr",
	"col",
	"fmt",
	"nl",
	"fold",
	"awk",
	"cat",
]);

// 安全只读的 git 子命令
const SAFE_GIT_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"branch",
	"remote",
	"rev-parse",
	"describe",
	"shortlog",
	"blame",
	"ls-files",
	"cat-file",
	"check-ignore",
	"config", // 读配置安全，但若有修改另行判定
	"tag",
]);

// 安全只读的包管理/编译检查子命令
const SAFE_PACKAGE_TOOL_SUBCOMMANDS: Record<string, Set<string>> = {
	npm: new Set(["list", "ls", "outdated", "view", "why", "info", "explain", "version", "--version", "-v"]),
	pnpm: new Set(["list", "ls", "outdated", "why", "view", "info", "version", "--version", "-v"]),
	yarn: new Set(["list", "why", "info", "outdated", "version", "--version", "-v"]),
	cargo: new Set(["check", "metadata", "tree", "verify-project", "--version", "-V", "help"]),
	go: new Set(["version", "env", "list", "doc", "vet"]),
	python: new Set(["--version", "-V", "-c"]),
	python3: new Set(["--version", "-V", "-c"]),
	node: new Set(["--version", "-v"]),
};

interface Token {
	type: "word" | "op" | "redir" | "subst";
	value: string;
}

/**
 * 词法状态机分词：解析 Shell 字符串并隔离引号与转义
 */
export function tokenizeShellCommand(cmd: string): { tokens: Token[]; hasCommandSubstitution: boolean } {
	const tokens: Token[] = [];
	let hasCommandSubstitution = false;
	let i = 0;
	const len = cmd.length;

	while (i < len) {
		const char = cmd[i];

		// 跳过空白字符
		if (/\s/.test(char)) {
			i++;
			continue;
		}

		// 1. 命令替换检测: $(...) 或 `...` 或 <(...) 或 >(...)
		if (char === "`") {
			hasCommandSubstitution = true;
			// 查找闭合反引号
			i++;
			let sub = "";
			while (i < len && cmd[i] !== "`") {
				if (cmd[i] === "\\" && i + 1 < len) {
					sub += cmd[i + 1];
					i += 2;
				} else {
					sub += cmd[i];
					i++;
				}
			}
			if (i < len && cmd[i] === "`") i++;
			tokens.push({ type: "subst", value: sub });
			continue;
		}

		if (char === "$" && i + 1 < len && cmd[i + 1] === "(") {
			hasCommandSubstitution = true;
			i += 2;
			let depth = 1;
			let sub = "";
			while (i < len && depth > 0) {
				if (cmd[i] === "(") depth++;
				else if (cmd[i] === ")") depth--;
				if (depth > 0) sub += cmd[i];
				i++;
			}
			tokens.push({ type: "subst", value: sub });
			continue;
		}

		if ((char === "<" || char === ">") && i + 1 < len && cmd[i + 1] === "(") {
			hasCommandSubstitution = true;
			i += 2;
			let depth = 1;
			let sub = "";
			while (i < len && depth > 0) {
				if (cmd[i] === "(") depth++;
				else if (cmd[i] === ")") depth--;
				if (depth > 0) sub += cmd[i];
				i++;
			}
			tokens.push({ type: "subst", value: sub });
			continue;
		}

		// 2. 重定向操作符: >>, >|, &>, &>>, 2>&1, 1>&2, >, <
		// 需消除 2>&1 等纯描述符重定向与文件重定向的区别
		if (
			cmd.slice(i, i + 4) === "2>&1" ||
			cmd.slice(i, i + 4) === "1>&2" ||
			cmd.slice(i, i + 3) === ">&1" ||
			cmd.slice(i, i + 3) === ">&2"
		) {
			tokens.push({ type: "redir", value: cmd.slice(i, i + (cmd[i + 2] === "&" ? 4 : 3)) });
			i += cmd[i + 2] === "&" ? 4 : 3;
			continue;
		}

		if (
			cmd.slice(i, i + 3) === "&>>" ||
			cmd.slice(i, i + 2) === ">>" ||
			cmd.slice(i, i + 2) === "&>" ||
			cmd.slice(i, i + 2) === ">|"
		) {
			const op = cmd.slice(i, i + (cmd.slice(i, i + 3) === "&>>" ? 3 : 2));
			tokens.push({ type: "redir", value: op });
			i += op.length;
			continue;
		}

		if (char === ">" || char === "<") {
			tokens.push({ type: "redir", value: char });
			i++;
			continue;
		}

		// 3. 控制与逻辑操作符: &&, ||, |&, |, ;;, ;, &
		if (cmd.slice(i, i + 2) === "&&" || cmd.slice(i, i + 2) === "||" || cmd.slice(i, i + 2) === "|&") {
			tokens.push({ type: "op", value: cmd.slice(i, i + 2) });
			i += 2;
			continue;
		}

		if (char === "|" || char === ";") {
			tokens.push({ type: "op", value: char });
			i++;
			continue;
		}

		if (char === "&") {
			tokens.push({ type: "op", value: "&" });
			i++;
			continue;
		}

		// 4. 普通词（包含单双引号与字符处理）
		let word = "";
		while (i < len && !/\s/.test(cmd[i])) {
			const c = cmd[i];

			// 遇到控制操作符或重定向符中断当前 word
			if (c === "|" || c === "&" || c === ";" || c === ">" || c === "<" || c === "`") {
				break;
			}
			if (c === "$" && i + 1 < len && cmd[i + 1] === "(") {
				break;
			}

			// 单引号字符串：完全字面量，不解释转义
			if (c === "'") {
				i++;
				while (i < len && cmd[i] !== "'") {
					word += cmd[i];
					i++;
				}
				if (i < len && cmd[i] === "'") i++;
				continue;
			}

			// 双引号字符串：解释转义字符
			if (c === '"') {
				i++;
				while (i < len && cmd[i] !== '"') {
					if (cmd[i] === "\\" && i + 1 < len) {
						word += cmd[i + 1];
						i += 2;
					} else {
						word += cmd[i];
						i++;
					}
				}
				if (i < len && cmd[i] === '"') i++;
				continue;
			}

			// 反斜杠转义
			if (c === "\\" && i + 1 < len) {
				word += cmd[i + 1];
				i += 2;
				continue;
			}

			word += c;
			i++;
		}

		if (word.length > 0) {
			// 检测是否形如 1> 或 2>
			if (/^[0-9]+>+$/.test(word)) {
				tokens.push({ type: "redir", value: word });
			} else {
				tokens.push({ type: "word", value: word });
			}
		}
	}

	return { tokens, hasCommandSubstitution };
}

/**
 * 剥离前导环境变量定义 (例如 FOO=bar BAZ=1 node -> node)
 */
export function stripLeadingEnvVars(words: string[]): { envVars: string[]; commandWords: string[] } {
	const envVars: string[] = [];
	let i = 0;
	while (i < words.length) {
		const w = words[i];
		// 环境变量模式: KEY=VAL
		if (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(w)) {
			envVars.push(w);
			i++;
		} else {
			break;
		}
	}
	return { envVars, commandWords: words.slice(i) };
}

/**
 * 校验单一简单命令语句的安全性与只读属性
 */
function checkSingleCommandSafety(words: string[]): { isReadOnly: boolean; reason?: string; binary: string } {
	const { commandWords } = stripLeadingEnvVars(words);
	if (commandWords.length === 0) {
		return { isReadOnly: true, binary: "" };
	}

	// 提取可执行二进制名称 (剥离路径如 /usr/bin/git -> git)
	const rawBin = commandWords[0];
	const binary = rawBin.includes("/") ? rawBin.split("/").pop() || rawBin : rawBin;

	if (!SAFE_READ_ONLY_BINARIES.has(binary)) {
		return {
			isReadOnly: false,
			reason: `命令 "${binary}" 未在只读白名单中`,
			binary,
		};
	}

	const args = commandWords.slice(1);

	// 1. find 深度安全校验：严禁 -exec, -execdir, -ok, -okdir, -delete
	if (binary === "find") {
		for (const arg of args) {
			if (
				arg === "-exec" ||
				arg === "-execdir" ||
				arg === "-ok" ||
				arg === "-okdir" ||
				arg === "-delete"
			) {
				return {
					isReadOnly: false,
					reason: `find 命令携带危险执行参数 "${arg}"，存在写入或执行风险`,
					binary,
				};
			}
		}
	}

	// 2. git 深度安全校验：仅放行只读子命令
	if (binary === "git") {
		// 寻找第一个非 flag 的子命令
		let subcmd: string | undefined;
		let subcmdIndex = -1;
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (!a.startsWith("-")) {
				subcmd = a;
				subcmdIndex = i;
				break;
			}
		}

		if (!subcmd) {
			// 纯 git 或 git --version，只读
			return { isReadOnly: true, binary };
		}

		if (!SAFE_GIT_SUBCOMMANDS.has(subcmd)) {
			return {
				isReadOnly: false,
				reason: `git 子命令 "${subcmd}" 具有修改或网络副作用，非只读操作`,
				binary,
			};
		}

		// git branch 严禁 -d, -D, -m, -M, --delete
		if (subcmd === "branch") {
			const branchArgs = args.slice(subcmdIndex + 1);
			for (const ba of branchArgs) {
				if (ba === "-d" || ba === "-D" || ba === "-m" || ba === "-M" || ba === "--delete") {
					return {
						isReadOnly: false,
						reason: `git branch 携带分支删除/重命名参数 "${ba}"`,
						binary,
					};
				}
			}
		}

		// git config 若带参数写入值则非只读
		if (subcmd === "config") {
			const configArgs = args.slice(subcmdIndex + 1).filter((a) => !a.startsWith("-"));
			// git config key (读取) vs git config key value (修改)
			if (configArgs.length >= 2) {
				return {
					isReadOnly: false,
					reason: `git config 正在修改配置项: "${configArgs[0]}"`,
					binary,
				};
			}
		}
	}

	// 3. 包管理工具 (npm/pnpm/yarn/cargo/go) 校验
	if (SAFE_PACKAGE_TOOL_SUBCOMMANDS[binary]) {
		const allowedSubs = SAFE_PACKAGE_TOOL_SUBCOMMANDS[binary];
		const firstArg = args.find((a) => !a.startsWith("-")) || args[0];
		if (!firstArg || !allowedSubs.has(firstArg)) {
			return {
				isReadOnly: false,
				reason: `${binary} 正在执行变更或脚本命令: "${firstArg || "默认"}"`,
				binary,
			};
		}
	}

	// 4. sed / awk / perl 严禁 -i 或 --in-place
	if (binary === "sed" || binary === "awk" || binary === "perl") {
		for (const arg of args) {
			if (arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place=")) {
				return {
					isReadOnly: false,
					reason: `${binary} 携带就地修改文件参数 "${arg}"`,
					binary,
				};
			}
		}
	}

	// 5. python / node -e / -c 动态代码执行排查
	if (binary === "python" || binary === "python3" || binary === "node") {
		if (args.includes("-c") || args.includes("-e")) {
			return {
				isReadOnly: false,
				reason: `${binary} 包含内联代码动态求值参数 (-c / -e)`,
				binary,
			};
		}
	}

	return { isReadOnly: true, binary };
}

/**
 * 工业级 Shell 命令安全与只读属性深度分析
 */
export function analyzeShellCommand(rawCommand: string): ShellAnalysisResult {
	const cmd = rawCommand.trim();
	if (!cmd) {
		return {
			isReadOnly: true,
			hasWriteRedirection: false,
			hasCommandSubstitution: false,
			hasDangerousFlag: false,
			detectedCommands: [],
		};
	}

	// 1. 词法分词与命令替换检测
	const { tokens, hasCommandSubstitution } = tokenizeShellCommand(cmd);

	if (hasCommandSubstitution) {
		return {
			isReadOnly: false,
			hasWriteRedirection: false,
			hasCommandSubstitution: true,
			hasDangerousFlag: false,
			reason: "检测到动态命令替换 ($() 或 `...`)，无法静态保证安全性",
			detectedCommands: [],
		};
	}

	// 2. 检测是否存在写入重定向
	let hasWriteRedirection = false;
	for (const t of tokens) {
		if (t.type === "redir") {
			// 过滤掉纯描述符重定向 (2>&1, 1>&2)
			if (t.value === "2>&1" || t.value === "1>&2" || t.value === ">&1" || t.value === ">&2") {
				continue;
			}
			// 凡是 >, >>, &>, >|, 1>, 2> 均为文件写入重定向！
			if (t.value.includes(">")) {
				hasWriteRedirection = true;
				break;
			}
		}
	}

	if (hasWriteRedirection) {
		return {
			isReadOnly: false,
			hasWriteRedirection: true,
			hasCommandSubstitution: false,
			hasDangerousFlag: false,
			reason: "命令包含输出重定向写入 (> 或 >>)，具备文件写副作用",
			detectedCommands: [],
		};
	}

	// 3. 复合语句分段：按 &&, ||, ;, & 拆分
	const compoundSegments: Token[][] = [];
	let currentSegment: Token[] = [];

	for (const t of tokens) {
		if (t.type === "op" && (t.value === "&&" || t.value === "||" || t.value === ";" || t.value === "&")) {
			if (currentSegment.length > 0) {
				compoundSegments.push(currentSegment);
				currentSegment = [];
			}
		} else {
			currentSegment.push(t);
		}
	}
	if (currentSegment.length > 0) {
		compoundSegments.push(currentSegment);
	}

	const allDetectedCommands: string[] = [];

	// 4. 逐段分析每个复合命令语句及其内部管道
	for (const segment of compoundSegments) {
		// 按管道 | 拆分 pipeline stages
		const pipelineStages: Token[][] = [];
		let currentStage: Token[] = [];

		for (const t of segment) {
			if (t.type === "op" && (t.value === "|" || t.value === "|&")) {
				if (currentStage.length > 0) {
					pipelineStages.push(currentStage);
					currentStage = [];
				}
			} else {
				currentStage.push(t);
			}
		}
		if (currentStage.length > 0) {
			pipelineStages.push(currentStage);
		}

		for (let sIdx = 0; sIdx < pipelineStages.length; sIdx++) {
			const stageTokens = pipelineStages[sIdx];
			const words = stageTokens.filter((t) => t.type === "word").map((t) => t.value);

			if (words.length === 0) continue;

			// 检查是否为管道下游过滤器
			if (sIdx > 0) {
				const { commandWords } = stripLeadingEnvVars(words);
				const filterBin = (commandWords[0] || "").split("/").pop() || "";
				allDetectedCommands.push(filterBin);

				if (!SAFE_PIPE_FILTERS.has(filterBin)) {
					return {
						isReadOnly: false,
						hasWriteRedirection: false,
						hasCommandSubstitution: false,
						hasDangerousFlag: false,
						reason: `管道下游包含未授权的非只读/不安全过滤器: "${filterBin}"`,
						detectedCommands: allDetectedCommands,
					};
				}
				continue;
			}

			// 管道起始命令或普通命令
			const check = checkSingleCommandSafety(words);
			if (check.binary) {
				allDetectedCommands.push(check.binary);
			}

			if (!check.isReadOnly) {
				return {
					isReadOnly: false,
					hasWriteRedirection: false,
					hasCommandSubstitution: false,
					hasDangerousFlag: true,
					reason: check.reason,
					detectedCommands: allDetectedCommands,
				};
			}
		}
	}

	return {
		isReadOnly: true,
		hasWriteRedirection: false,
		hasCommandSubstitution: false,
		hasDangerousFlag: false,
		detectedCommands: allDetectedCommands,
	};
}
