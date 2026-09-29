
# Pi Approval Mode (`pi-approval-mode`)

English | [中文文档](#中文文档)

> **Multi-tiered tool execution approval, permission memory, and two-stage LLM safety classifier for [Pi Coding Agent](https://github.com/earendil-works/pi).**  
> Faithfully implementing and extending the security architecture of **Qwen Code**.

---

## 🌟 Highlights

- **5 Approval Modes**: `default`, `auto-edit`, `auto`, `yolo`, and `plan`.
- **Four-State Permission Rules (`deny` > `ask` > `default` > `allow`)**:
  - **`deny`**: Hard blocking at runtime without modal prompt; takes precedence over everything.
  - **`ask`**: Enforces interactive confirmation modal, overriding auto-approval modes.
  - **`default`**: Delegates to the approval-mode funnel (LLM classifier in `auto`, manual confirmation otherwise); optional — omit it and behavior matches the original tri-state design.
  - **`allow`**: Auto-approves matching operations.
  - **Tool default permission layer**: read-family tools (`read`/`grep`/`find`/`ls`) with no matching rule fast-path inside the workspace and require confirmation outside it (including `~` expansion).
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
- **Safe Session Resume (`pi -c`) & Ghost Privilege Escalation Defense**:
  - **CLI Wins**: Explicit `--approval-mode` or `--yolo` always takes precedence.
  - **YOLO Safe Downgrade**: If resumed session or reload was left in YOLO mode, automatically downgrades to safe baseline mode to prevent accidental destruction.
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
Configure the approval mode, classifier model, timeout, and loop detection thresholds globally or per-project:
- Global: `~/.pi/agent/approval-config.json`
- Project: `<workspace>/.pi/approval-config.json`

```json
{
  "classifierModel": "llm-proxy-openai-chat/gemini-3.8-flash-high-lp",
  "defaultMode": "auto",
  "classifierTimeoutMs": 1500,
  "loopDetection": {
    "identicalThreshold": 3,
    "denialThreshold": 3,
    "stagnationThreshold": 6
  }
}
```

### 2. Four-State Permission Rules (`approval-rules.json`)
Pre-configure rules matching Qwen Code DSL (`deny` > `ask` > `default` > `allow`):
- Global: `~/.pi/agent/approval-rules.json`
- Project: `<workspace>/.pi/approval-rules.json`

```json
{
  "allow": [
    "Bash(git status)",
    "Bash(git diff *)",
    "Read(/src/**)"
  ],
  "default": [
    "Read(./secrets/**)"
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

### 3. Dual-Config Architecture & Merging Semantics
Why two distinct configuration files?
- **`approval-rules.json` (Permission Rules)**: Evaluated using **Union + Deny-First** semantics. Rules across all scopes are aggregated into global pools. A denial rule in any layer can never be overridden by an allow rule in another layer, maintaining absolute defense-in-depth.
- **`approval-config.json` (Runtime Settings & Thresholds)**: Evaluated using **Top-Level Shallow Merge** semantics (`{ ...global, ...project }`). Project-level settings take precedence over global settings. If a project defines a top-level key (such as `classifierModel`, `defaultMode`, or `loopDetection`), it completely overrides that top-level key from the user configuration.

### 4. Four-State Priority & Multi-Tier Rule Resolution
Rules across all three tiers (**Session**, **Project**, **User**) are resolved strictly by verdict priority:
$$\text{Deny} > \text{Ask} > \text{Default} > \text{Allow}$$

1. **Independent Loading**:
   - **Session**: In-memory ephemeral rules (valid for current session only).
   - **Project**: Workspace-level (`<workspace>/.pi/approval-rules.json`).
   - **User**: Global-level (`~/.pi/agent/approval-rules.json`).
2. **Union Rule Pools**:
   - $\text{Deny Pool} = \text{Session} \cup \text{Project} \cup \text{User}$
   - $\text{Ask Pool} = \text{Session} \cup \text{Project} \cup \text{User}$
   - $\text{Default Pool} = \text{Session} \cup \text{Project} \cup \text{User}$
   - $\text{Allow Pool} = \text{Session} \cup \text{Project} \cup \text{User}$
3. **Short-Circuit Evaluation**:
   - **Deny First**: If any matched rule is in the Deny pool, the action is **immediately blocked without prompt**.
   - **Ask Second**: If matched in the Ask pool, an interactive confirmation modal is **always enforced** (even in `auto` mode).
   - **Default Third**: If matched in the Default pool, the action **delegates to the active Approval Mode** (LLM classifier in `auto` mode — interactive fallback to manual, headless rejection; manual confirmation otherwise).
   - **Allow Fourth**: If matched in the Allow pool, the action is **auto-approved**.
   - **Fallback Default**: If no explicit rule matches, delegates to the active Approval Mode; read-family tools additionally pass through the **tool default permission layer** (fast-path inside the workspace, confirmation outside).

> **Crucial Invariant**: **Verdict priority strictly trumps scope tier.** Tiers only determine where rules are persisted and their lifecycle; tiers do not determine precedence. A user-level `deny` will definitively block a project-level or session-level `allow`.

### 5. Lifecycle: `/reload` and Session Resumption
- **`/reload` Session Rule Reset**:
  - In the current release, running Pi's `/reload` reinitializes the permission manager. As a result, **in-memory session-level temporary approvals are cleared and reset** to the persisted baseline.
  - To persist rules across `/reload` and future sessions, choose **"Always allow in this project" (tier 3)** or **"Always allow for this user" (tier 4)** during modal approval.
- **YOLO Safe Downgrade (Ghost Privilege Escalation Defense)**:
  - When reloading (`/reload`) or resuming a session (`pi -c` / `pi -r`), if the resumed session was previously in `yolo` mode, it is **automatically downgraded to the safe baseline mode** (`default` or your configured `defaultMode`) with a warning notification.
  - This prevents accidental damage from unintended commands executing autonomously after session re-attachment.
  - Other workflow modes (`plan`, `auto`, `auto-edit`) are faithfully preserved.
  - To force YOLO mode across starts, explicitly pass `pi --yolo` (CLI flags hold absolute highest precedence).

---

## ⌨️ Shortcuts & Commands

- **`Ctrl+Alt+A`**: Cycle through modes (`default` ➔ `auto-edit` ➔ `auto` ➔ `yolo` ➔ `plan`).
- **`/approval-mode [mode]`**: Switch approval mode.
- **`/classifier-model [provider/model]`**: View or configure classifier model.
- **`/approval-rules [list|clear]`**: View or clear permission rules.

---

<a name="中文文档"></a>
# 中文说明

为 **Pi Coding Agent** 提供对齐 **千问 Code (Qwen Code)** 的多级工具审批模式、四态权限规则体系与两阶段 LLM 安全分类器。

### 核心能力

1. **五大运行模式**：`default`（标准）、`auto-edit`（免审编辑）、`auto`（智能两阶段分类）、`yolo`（全自动）、`plan`（只读规划）。
2. **Qwen Code 风格四态权限预设 (`deny` > `ask` > `default` > `allow`)**：
   - 支持 DSL 规则语法：`Tool(specifier)`（如 `Bash(git status)`, `Read(/src/**)`, `Read(.env*)`, `Edit(/package.json)`）；
   - 支持宏分类：`Read`（只读文件/搜索/目录）、`Edit`（编辑与写入）、`Bash`（Shell 命令）；
   - `default` 规则＝「交给审批模式」（auto 走分类器、非交互拒绝）；不配置时行为与三态现状一致（复杂度按需付费）；
   - 跨层级 Union 并集加载与 Deny-First 绝对封顶机制；
   - **工具默认权限层**：读类工具（`read`/`grep`/`find`/`ls`）未命中规则时，工作区内快路径放行、工作区外强制人工（含 `~` 展开）。
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

---

### 深入配置与生命周期机制

#### 1. 双配置文件设计与合并语义差异
为什么插件需要区分两个独立的配置文件？
- **`approval-rules.json`（权限规则文件）**：采用 **全层并集（Union）+ 拒绝优先（Deny-First）** 语义。
  - 用户层与项目层的规则在内存中汇总合并，互为补充。
  - 核心原则：**任何层的安全底线不可被另一层篡改或削弱**。例如，用户全局声明了 `deny: ["Read(.env*)"]`，即便特定项目写了 `allow: ["Read(.env*)"]` 也无法绕过拦截。
- **`approval-config.json`（运行参数与阈值文件）**：采用 **顶层浅覆盖（Top-Level Shallow Merge）** 语义。
  - 项目级配置优先于全局配置（`{ ...userConfig, ...projectConfig }`）。
  - 若项目级配置指定了某个同名顶层键（如 `classifierModel`、`defaultMode`、`loopDetection` 等），则该顶层键整体替换全局默认值，便于为特定仓库定制专属模型或放宽死循环判定阈值。

#### 2. 三层规则合并与 Deny-First 绝对裁决
规则裁决严格遵循：
$$\text{Deny} > \text{Ask} > \text{Default} > \text{Allow}$$

- **规则池汇总**：
  - 会话级（Session，仅保存在内存）、项目级（Project，`<workspace>/.pi/approval-rules.json`）、用户级（User，`~/.pi/agent/approval-rules.json`）分别独立加载；
  - 运行时按裁决类型汇聚为四大集合：$\text{Deny 集合}$、$\text{Ask 集合}$、$\text{Default 集合}$、$\text{Allow 集合}$。
- **裁决顺序与短路**：
  1. **Deny 优先（一票否决）**：命中任意层的 Deny 规则即刻阻断工具调用，静默拦截不弹窗；
  2. **Ask 次之（强制交互）**：命中 Ask 规则时，即使处于 `auto` 免审模式也会强行唤起审批弹窗；
  3. **Default 再次（交给审批模式）**：命中显式 `default` 规则时，交由模式漏斗裁决——`auto` 下先经两阶段分类器（交互不通过转人工、非交互不通过直接拒绝），非 `auto` 下人工确认；
  4. **Allow 免审放行**：若未命中 Deny/Ask/Default 且命中 Allow 规则，直接自动放行；
  5. **未命中兜底 Default**：未命中任何显式规则时返回 Default，交由当前运行模式裁决；其中**读类工具**先经**工具默认权限层**（工作区内快路径放行、工作区外强制人工）。
- **核心原则**：**裁决类型（Verdict）优先级严格高于规则层级（Scope）**。层级只决定规则存放在哪里与存活多久，不决定谁能胜出。任何层级的 Deny 绝对压死所有层级的 Allow。

#### 3. `/reload` 与会话恢复生命周期
- **`/reload` 对临时会话规则的无损保留与模型热载**：
  - 在 Pi 内部执行 `/reload` 时，插件遵循“**保留内存态会话授权、热载磁盘规则与模型目录**”的契约。之前通过弹窗授权的会话级（Session）免审规则会被**完整保留**，避免频繁弹窗打扰用户正常工作流。
  - 同时，`/reload` 会触发模型注册表就地刷新（`modelRegistry.refresh({ allowNetwork: false })`），使刚刚写入 `models.json` 或 `approval-config.json` 的分类器模型无需重启即可生效，并在重载完成后弹出清晰的状态摘要。
- **YOLO 模式安全降级（防幽灵提权）**：
  - 当通过 `/reload` 重载或通过 `pi -c` / `pi -r` 恢复历史会话时，如果历史会话处于 `yolo`（全自动免审）状态，插件将**强制自动重置为安全基线模式**（默认为 `default` 或配置的 `defaultMode`），并发出警示通知。
  - 该设计防止用户在恢复历史会话或重载时，因忘记先前的 YOLO 状态而导致 Agent 在无提示下误执行高危破坏性指令。
  - `plan`、`auto`、`auto-edit` 等安全模式在重载或恢复时均会无缝保持。
  - 若启动时确需全自动执行，请显式使用命令行参数 `pi --yolo`（CLI 旗标享有绝对最高裁决权）。

#### 4. 项目配置信任安全闸（Project Trust Gate）
- **核心对齐 Pi 原生安全信任机制**：
  - 插件在加载项目级 `.pi/approval-config.json` 与 `.pi/approval-rules.json` 时，会通过 `ctx.isProjectTrusted()` 严格核验工作区信任状态。
  - **未受信任时强行隔离**：若项目未受信任（例如刚从网络克隆的未知仓库），项目级配置与规则将被**绝对阻断禁用**，完全降级使用用户全局配置，并向用户发出安全告警。这彻底阻断了恶意仓库通过携带 `defaultMode: "yolo"` 或 `allow: ["Bash(*)"]` 进行提权逃逸的可能。
  - **信任启用入口**：使用 Pi 原生的 `--approve`（`-a`）CLI 旗标启动，或通过信任确认弹窗记住信任后，项目级配置即无缝加载生效。

---

### 一键安装

```bash
pi install git:github.com/CNCSMonster/pi-approval-mode
```

### 许可证

MIT License © 2026 CNCSMonster
