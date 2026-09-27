# Pi Approval Mode (`pi-approval-mode`)

English | [中文文档](#中文文档)

> **Multi-tiered tool execution approval, permission memory, and two-stage LLM safety classifier for [Pi Coding Agent](https://github.com/earendil-works/pi).**  
> Faithfully implementing and extending the security architecture of **Qwen Code**.

---

## 🌟 Highlights

- **5 Approval Modes**: `default`, `auto-edit`, `auto`, `yolo`, and `plan`.
- **Tri-State Permission Rules (`deny` > `ask` > `allow`)**:
  - **`deny`**: Hard blocking at runtime without modal prompt; takes precedence over everything.
  - **`ask`**: Enforces interactive confirmation modal, overriding auto-approval modes.
  - **`allow`**: Auto-approves matching operations.
- **Rule DSL & Meta-categories**:
  - Format: `Tool(specifier)` (e.g. `Bash(git status)`, `Bash(git *)`, `Read(/src/**)`, `Read(.env*)`, `Edit(/package.json)`).
  - Meta-categories: `Read` (covers read, grep, glob), `Edit` (covers edit, write), `Bash` (covers bash).
  - Scope prefixes: `//...` (filesystem root), `~/...` (home), `/...` (project root), `./...` (cwd).
- **Industrial-Grade Shell Lexer & Guard**:
  - Full lexer states for single/double quotes and escape sequences.
  - Write redirection guard (`>`, `>>`, `&>`) completely revokes read-only privileges.
  - Compound command splitting (`&&`, `||`, `;`, `&`) prevents injection bypass.
  - Subshell & command substitution defenses (`$()`, \`...\`).
  - Flag guards for `find` (`-exec`, `-delete`), `git` (write subcommands), `sed` (`-i`).
- **Two-Stage LLM Classifier**:
  - **Stage 1 (Fast)**: ~300ms quick check with timeout circuit-breaker.
  - **Stage 2 (Review)**: CoT deep review on flagged actions to eliminate false positives.
  - **Fallback**: Graceful fallback to deterministic heuristic rules if offline or unconfigured.
- **Single-Key Number Shortcuts**: Press `1` ~ `5` to instantly select an action in the approval modal without pressing Enter.
- **3-Tier Permission Memory**:
  - `1`: Allow once
  - `2`: Allow in this session (in-memory)
  - `3`: Always allow in this project (`.pi/approval-rules.json`)
  - `4`: Always allow for this user (`~/.pi/agent/approval-rules.json`)
  - `5`: Block (`Esc` / `q`)
- **Safe Session Resume (`pi -c`)**:
  - **CLI Wins**: Explicit `--approval-mode` or `--yolo` always takes precedence.
  - **YOLO Safe Downgrade**: If resumed session was left in YOLO mode, automatically downgrades to safe baseline mode to prevent accidental destruction.
  - **Workflow Preservation**: Safely preserves `plan`, `auto`, `auto-edit`, or `default`.
- **Zero Core Changes**: Pure Pi extension packaged according to the official Pi Package specifications.

---

## 📦 Installation

Install as a Pi package with a single command:

```bash
pi install git:github.com/CNCSMonster/pi-approval-mode
```

To update anytime:
```bash
pi update
```

---

## 🛡️ Approval Modes

| Mode | Status Badge | Description |
| :--- | :--- | :--- |
| **`default`** | `[🛡️ default]` | **Safe baseline**. Edits, writes, and shell commands require approval. Read-only tools are auto-approved. |
| **`auto-edit`** | `[📝 auto-edit]` | Auto-approves file edits; only shell commands (`bash`) require confirmation. |
| **`auto`** | `[🤖 auto]` | **Classifier-driven**. 3-layer filter funnel + 2-stage LLM classifier. Safe operations proceed seamlessly; risky operations are reviewed. |
| **`yolo`** | `[⚡ yolo]` | **Autonomous**. All tool calls execute without prompts (Pi core default). |
| **`plan`** | `[📋 plan]` | **Read-only planning**. Disables `edit` and `write`; limits shell to read-only commands; injects planning instructions. |

---

## ⚙️ Configuration

### 1. Mode & Classifier (`approval-config.json`)
Configure the approval mode, classifier model, and timeout globally or per-project:
- Global: `~/.pi/agent/approval-config.json`
- Project: `<workspace>/.pi/approval-config.json`

```json
{
  "classifierModel": "llm-proxy-openai-chat/gemini-3.8-flash-high-lp",
  "defaultMode": "auto",
  "classifierTimeoutMs": 1500
}
```

### 2. Tri-State Permission Rules (`approval-rules.json`)
Pre-configure rules matching Qwen Code DSL (`deny` > `ask` > `allow`):
- Global: `~/.pi/agent/approval-rules.json`
- Project: `<workspace>/.pi/approval-rules.json`

```json
{
  "allow": [
    "Bash(git status)",
    "Bash(git diff *)",
    "Read(/src/**)"
  ],
  "ask": [
    "Bash(git push *)",
    "Edit(/package.json)"
  ],
  "deny": [
    "Read(.env*)",
    "Read(~/.ssh/**)",
    "Bash(rm -rf *)",
    "Bash(sudo *)"
  ]
}
```

---

## ⌨️ Shortcuts & Commands

- **`Ctrl+Alt+A`**: Cycle through modes (`default` ➔ `auto-edit` ➔ `auto` ➔ `yolo` ➔ `plan`).
- **`/approval-mode [mode]`** or **`/mode [mode]`**: Switch approval mode.
- **`/classifier-model [provider/model]`**: View or configure classifier model.
- **`/approval-rules [list|clear]`**: View or clear permission rules.
- **`/yolo`**: Toggle YOLO mode.
- **`/plan`**: Toggle Plan mode.

---

<a name="中文文档"></a>
# 中文说明

为 **Pi Coding Agent** 提供对齐 **千问 Code (Qwen Code)** 的多级工具审批模式、三态权限规则体系与两阶段 LLM 安全分类器。

### 核心能力

1. **五大运行模式**：`default`（标准）、`auto-edit`（免审编辑）、`auto`（智能两阶段分类）、`yolo`（全自动）、`plan`（只读规划）。
2. **Qwen Code 风格三态权限预设 (`deny` > `ask` > `allow`)**：
   - 支持 DSL 规则语法：`Tool(specifier)`（如 `Bash(git status)`, `Read(/src/**)`, `Read(.env*)`, `Edit(/package.json)`）；
   - 支持宏分类：`Read`（只读文件/搜索/目录）、`Edit`（编辑与写入）、`Bash`（Shell 命令）；
   - 跨层级 Union 并集加载与 Deny-First 绝对封顶机制。
3. **工业级 Shell 状态机分析器（拒绝玩具级正则）**：
   - 词法状态机解析单双引号与转义，杜绝复合命令（`&&`, `||`, `;`, `&`）注入逃逸；
   - 写入重定向（`>`, `>>`, `&>`）一票否决只读属性；
   - 管道下游过滤器安全守卫与子 Shell / 命令替换（`$()`, \`...\`）提权阻断；
   - 针对 `find`（`-exec`）、`git`（非只读子命令）、`sed`（`-i`）等实施深度参数级校验。
4. **两阶段安全分类器 (Two-Stage Classifier)**：
   - Stage 1 极速初筛（配置 1500ms 超时熔断保护）+ Stage 2 深度复核；
   - 离线/异常平滑降级至启发式风控规则。
5. **数字键单键直选 TUI**：弹窗中**直接按数字键 1~5 瞬间选择**，无需按回车确认。
6. **安全会话恢复 (`pi -c`)**：
   - CLI 参数最高优先级；
   - YOLO 历史模式防幽灵提权自动降级为安全模式；
   - 安全模式（`plan`、`auto` 等）无缝保持工作流意图。

### 一键安装

```bash
pi install git:github.com/CNCSMonster/pi-approval-mode
```

### 许可证

MIT License © 2026 CNCSMonster
