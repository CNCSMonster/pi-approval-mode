# Pi Approval Mode (`pi-approval-mode`)

English | [中文文档](#中文文档)

> **Multi-tiered tool execution approval, permission memory, and two-stage LLM safety classifier for [Pi Coding Agent](https://github.com/earendil-works/pi).**  
> Faithfully implementing and extending the security architecture of **Qwen Code**.

---

## 🌟 Highlights

- **5 Approval Modes**: `default`, `auto-edit`, `auto`, `yolo`, and `plan`.
- **Qwen Code Two-Stage Classifier**:
  - **Layer 1 (Fast-path)**: In-workspace file modifications auto-approved (excluding self-modifications and credentials).
  - **Layer 2 (Read-only Fast-path)**: Safe read-only commands (`ls`, `cat`, `git status`, etc.) auto-approved with 0 latency.
  - **Layer 3 (Two-Stage LLM Classifier)**:
    - **Stage 1 (Fast)**: ~300ms quick check `{ shouldBlock: boolean }`.
    - **Stage 2 (Review)**: CoT deep review on flagged actions using recent conversation transcript to eliminate false positives.
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

## ⚙️ Configuration (`approval-config.json`)

Configure the approval mode and classifier model globally or per-project:
- Global: `~/.pi/agent/approval-config.json`
- Project: `<workspace>/.pi/approval-config.json`

```json
{
  "classifierModel": "llm-proxy-openai-chat/gemini-3.8-flash-high-lp",
  "defaultMode": "auto"
}
```

---

## ⌨️ Shortcuts & Commands

- **`Ctrl+Alt+A`**: Cycle through modes (`default` ➔ `auto-edit` ➔ `auto` ➔ `yolo` ➔ `plan`).
- **`/approval-mode [mode]`** or **`/mode [mode]`**: Switch approval mode.
- **`/classifier-model [provider/model]`**: View or configure classifier model.
- **`/approval-rules [list|clear]`**: View or clear allowlists.
- **`/yolo`**: Toggle YOLO mode.
- **`/plan`**: Toggle Plan mode.

---

<a name="中文文档"></a>
# 中文说明

为 **Pi Coding Agent** 提供对齐 **千问 Code (Qwen Code)** 的多级工具审批模式、两阶段 LLM 安全分类器与权限记忆体系。

### 核心能力

1. **五大运行模式**：`default`（标准）、`auto-edit`（免审编辑）、`auto`（智能两阶段分类）、`yolo`（全自动）、`plan`（只读规划）。
2. **两阶段安全分类器 (Two-Stage Classifier)**：
   - 过滤漏斗 1：工作区内常规文件编辑免审；敏感文件（如 `.pi/`、`.git/`、`AGENTS.md`、`.env` 等）转入分类器；
   - 过滤漏斗 2：只读命令（`ls`, `cat`, `git status`, `grep` 等）0 延迟免审；
   - 过滤漏斗 3：双阶段分类器（Stage 1 极速初筛 + Stage 2 深度意图复核 + 离线正则兜底）。
3. **数字键单键直选 TUI**：弹窗中**直接按数字键 1~5 瞬间选择**，无需按回车确认。
4. **三级免审记忆**：支持单次放行、当前会话免审、项目级持久化（`<cwd>/.pi/approval-rules.json`）、用户全局持久化（`~/.pi/agent/approval-rules.json`）。
5. **安全会话恢复 (`pi -c`)**：
   - CLI 参数最高优先级；
   - YOLO 历史模式防幽灵提权自动降级为安全模式；
   - 安全模式（`plan`、`auto` 等）无缝保持工作流意图。

### 一键安装

```bash
pi install git:github.com/CNCSMonster/pi-approval-mode
```

### 许可证

MIT License © 2026 CNCSMonster
