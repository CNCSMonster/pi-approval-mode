# 中文说明

[English](./README.md) | 简体中文


> **为 [Pi Coding Agent](https://github.com/earendil-works/pi) 提供多级工具执行审批、权限记忆与两阶段 LLM 安全分类器**——参考各家 code agent（Qwen Code、Claude Code、Codex、Gemini CLI 等）后沉淀的独立设计。  
> 📖 **完整使用手册：** [用户指南](https://github.com/CNCSMonster/pi-approval-mode/blob/main/docs/user-guide.md)。

---

## 🌟 核心能力

1. **五大运行模式**：`manual`（人审）、`auto-edit`（免审编辑）、`auto`（智能两阶段分类，**新会话默认**）、`yolo`（全自动）、`plan`（只读规划）。
2. **四态权限预设 (`deny` > `ask` > `default` > `allow`)**（判定态与 Qwen Code DSL 同源，便于迁移）：
   - `deny`：运行时硬阻断、不弹窗，压倒一切；
   - `ask`：强制人工确认弹窗，压倒一切免审模式；
   - `default`：交给审批模式漏斗（`auto` 走 LLM 分类器、其余模式人工确认）；可选——不配置即保持原三态行为；*（注：此处的 `default` 为规则判定态。原 `default` 审批模式已于 v0.3.0 更名为 `manual`，详见 [FAQ 5.6](docs/user-guide.zh-CN.md#56-default-模式哪去了)。）*
   - `allow`：命中自动放行；
   - 支持 DSL 规则语法：`Tool(specifier)`（如 `Bash(git status)`、`Read(/src/**)`、`Read(.env*)`、`Edit(/package.json)`）；
   - 宏分类：`Read`（read/grep/glob）、`Edit`（edit/write）、`Bash`（bash）；
   - 作用域前缀：`//...`（文件系统根）、`~/...`（家目录）、`/...`（项目根）、`./...`（当前目录）；
   - **工具默认权限层**：读类工具（`read`/`grep`/`find`/`ls`）未命中规则时，工作区内快路径放行、工作区外强制人工（含 `~` 展开，但 skill 目录受白名单豁免）。
3. **工业级 Shell 状态机分析器（拒绝玩具级正则）**：
   - 词法状态机解析单双引号与转义，杜绝复合命令（`&&`, `||`, `;`, `&`）注入逃逸；
   - 写入重定向（`>`, `>>`, `&>`）一票否决只读属性；
   - 管道下游过滤器安全守卫与子 Shell / 命令替换（`$()`, \`...\`）提权阻断；
   - 针对 `find`（`-exec`）、`git`（非只读子命令）、`sed`（`-i`）等实施深度参数级校验。
4. **两阶段安全分类器 (Two-Stage Classifier)**：
   - Stage 1 极速初筛（带超时熔断，默认 1500ms、可配置）+ Stage 2 思维链复核消除误报；
   - 离线/未配置平滑降级至确定性启发式风控规则。
5. **数字键单键直选 TUI**：弹窗中**直接按数字键 1~5 瞬间选择**，无需按回车确认。
6. **三级权限记忆**：
   - `1`：允许本次执行；
   - `2`：本会话内始终允许（内存态）；
   - `3`：在本项目始终允许（`.pi/approval-rules.json`）；
   - `4`：对该用户始终允许（`~/.pi/agent/approval-rules.json`）；
   - `5`：拒绝（`Esc` / `q`）。
7. **安全会话恢复 (`pi -c`) 与防幽灵提权**：
   - **CLI 最高优先级**：显式 `--approval-mode` 或 `--yolo` 始终压倒一切；
   - **YOLO 安全降级**：恢复的会话或重载遗留在 YOLO 状态时，自动降级回安全基线，防止误执行破坏性命令；
   - **工作流保持**：`plan`、`auto`、`auto-edit`、`manual` 在恢复/重载后原样保持。
8. **零核心改动**：按官方 Pi Package 规范打包的纯扩展。

---

## 📦 一键安装

```bash
pi install git:github.com/CNCSMonster/pi-approval-mode
```

随时更新：

```bash
pi update
```

---

## 🛡️ 审批模式

| 模式 | 状态徽标 | 说明 |
| :--- | :--- | :--- |
| **`manual`** | `[🛡️ manual]` | **人审模式**。编辑、写入与 Shell 命令逐个需人工审批；只读工具自动放行。 |
| **`auto-edit`** | `[📝 auto-edit]` | 区内文件免审，受保护路径与区外需确认，仅 shell 需审批 |
| **`auto`** | `[🤖 auto]` | **分类器驱动（新会话默认）**。三层过滤漏斗 + 两阶段 LLM 分类器：安全操作无感放行，风险操作研判确认；进入该模式时，宽到足以绕过分类器的 allow 规则会被**暂存剥离**（退出恢复）。 |
| **`yolo`** | `[⚡ yolo]` | **全自动**。所有工具调用免弹窗直接执行（Pi 内核默认）。 |
| **`plan`** | `[📋 plan]` | **只读规划**。禁用 `edit` 与 `write`；Shell 仅限只读命令；注入规划指令。 |

> 各模式 × 各工具的逐格行为（含分类器路由与无头运行）：见[用户指南 §2](https://github.com/CNCSMonster/pi-approval-mode/blob/main/docs/user-guide.md#2-approval-modes--tool-behavior)。

---

## ⚙️ 配置

### 1. 模式与分类器 (`approval-config.json`)
全局或按项目配置审批模式、分类器模型、超时与死循环检测阈值：
- 全局：`~/.pi/agent/approval-config.json`
- 项目：`<workspace>/.pi/approval-config.json`

```json
{
  "classifierModel": "llm-proxy-openai-chat/gemini-3.8-flash-high-lp",
  "classifierStage1Model": "cheap-fast-model",
  "classifierStage2Model": "strong-reasoning-model",
  "defaultMode": "auto",
  "classifierTimeoutMs": 1500,
  "loopDetection": {
    "identicalThreshold": 3,
    "denialThreshold": 3,
    "stagnationThreshold": 6
  }
}
```

### 2. 四态权限规则 (`approval-rules.json`)
预置符合 Qwen Code DSL 的规则（`deny` > `ask` > `default` > `allow`）：
- 全局：`~/.pi/agent/approval-rules.json`
- 项目：`<workspace>/.pi/approval-rules.json`

> **注**：此处的 `"default"` 为规则判定态。原 `default` 审批模式已于 v0.3.0 更名为 `manual`，详见 [FAQ 5.6](docs/user-guide.zh-CN.md#56-default-模式哪去了)。

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

### 3. 双配置文件设计与合并语义差异
为什么插件需要区分两个独立的配置文件？
- **`approval-rules.json`（权限规则文件）**：采用 **全层并集（Union）+ 拒绝优先（Deny-First）** 语义。用户层与项目层的规则在内存中汇总合并，互为补充。核心原则：**任何层的安全底线不可被另一层篡改或削弱**。例如，用户全局声明了 `deny: ["Read(.env*)"]`，即便特定项目写了 `allow: ["Read(.env*)"]` 也无法绕过拦截。
- **`approval-config.json`（运行参数与阈值文件）**：采用 **顶层浅覆盖（Top-Level Shallow Merge）** 语义（`{ ...userConfig, ...projectConfig }`）。项目级配置优先于全局配置；若项目级配置指定了某个同名顶层键（如 `classifierModel`、`defaultMode`、`loopDetection`），则该顶层键整体替换全局默认值，便于为特定仓库定制专属模型或放宽死循环判定阈值。

### 4. 四态优先级与多层规则裁决
三层规则（**会话**、**项目**、**用户**）严格按裁决类型优先级裁决：
$$\text{Deny} > \text{Ask} > \text{Default} > \text{Allow}$$

1. **独立加载**：
   - **会话（Session）**：内存态临时规则（仅当前会话有效）；
   - **项目（Project）**：工作区级（`<workspace>/.pi/approval-rules.json`）；
   - **用户（User）**：全局级（`~/.pi/agent/approval-rules.json`）。
2. **并集规则池**：
   - $\text{Deny 池} = \text{Session} \cup \text{Project} \cup \text{User}$
   - $\text{Ask 池} = \text{Session} \cup \text{Project} \cup \text{User}$
   - $\text{Default 池} = \text{Session} \cup \text{Project} \cup \text{User}$
   - $\text{Allow 池} = \text{Session} \cup \text{Project} \cup \text{User}$
3. **短路裁决**：
   - **Deny 最先（一票否决）**：命中任意层 Deny 规则即刻静默阻断；
   - **Ask 次之（强制交互）**：命中 Ask 规则必弹人工确认（`auto` 模式也不例外）；
   - **Default 再次（交给审批模式）**：命中 Default 规则交由当前审批模式裁决（`auto` 下 LLM 分类器——交互不通过转人工、非无头拒绝；其余模式人工确认）；
   - **Allow 其四（自动放行）**：命中 Allow 规则自动放行；
   - **未命中兜底 Default**：未命中显式规则时交由当前审批模式；读类工具额外经过**工具默认权限层**（工作区内快路径、工作区外人工确认）。

> **核心不变量**：**裁决类型（Verdict）优先级严格高于规则层级（Scope）**。层级只决定规则存放在哪里与存活多久，不决定谁能胜出。任何层级的 Deny 绝对压死所有层级的 Allow。

### 5. 生命周期：`/reload` 与会话恢复
- **`/reload` 会话规则保留与模型热载**：
  - 在 Pi 内部执行 `/reload` 时，**内存态会话级临时授权被完整保留**（弹窗产生的临时放行不因重载丢失），同时**模型注册表就地热载**——刚写入 `models.json` 或 `approval-config.json` 的分类器模型无需重启即可生效，重载完成后弹出清晰的状态摘要。
- **YOLO 安全降级（防幽灵提权）**：
  - 当通过 `/reload` 重载或通过 `pi -c` / `pi -r` 恢复历史会话时，如果遗留在 `yolo`（全自动免审）状态，插件将**强制自动重置为安全基线模式**（`auto` 或配置的 `defaultMode`），并发出警示通知。
  - 该设计防止恢复历史会话或重载时，因忘记先前的 YOLO 状态而导致 Agent 在无提示下误执行高危破坏性指令。
  - `plan`、`auto`、`auto-edit` 等工作流模式在重载或恢复时均会无缝保持。
  - 若启动时确需全自动执行，请显式使用命令行参数 `pi --yolo`（CLI 旗标享有绝对最高裁决权）。

### 6. 项目配置信任安全闸（Project Trust Gate）
- 项目级 `.pi/approval-config.json` 与 `.pi/approval-rules.json` 仅在**受信任**项目中加载，通过 Pi 原生信任状态（`ctx.isProjectTrusted()`）核验：
  - **未受信任时强行隔离**：项目级配置与规则被完全忽略，回落到全局配置并告警。这彻底阻断了恶意仓库通过自带 `defaultMode: "yolo"` 或 `allow: ["Bash(*)"]` 提权逃逸的可能。
  - **信任入口**：使用 Pi 原生 `pi --approve …`（`-a`）旗标启动，或接受 Pi 的信任确认弹窗一次即可。

---

## ⌨️ 快捷键与命令

- **`Ctrl+Alt+A`**：循环切换模式（`manual` ➔ `auto-edit` ➔ `auto` ➔ `yolo` ➔ `plan`）。
- **`/approval-mode [mode]`**：切换审批模式。
- **`/classifier-model [provider/model]`**：查看或配置分类器模型。
- **`/approval-rules [list|clear]`**：查看或清空权限规则。

---

## 📄 许可证

MIT License © 2026 CNCSMonster
