# Pi Approval Mode (`pi-approval-mode`)

English | [简体中文](./README.zh-CN.md)

> **Multi-tiered tool execution approval, permission memory, and two-stage LLM safety classifier for [Pi Coding Agent](https://github.com/earendil-works/pi)** — an independent design distilled from studying Claude Code, Codex, Qwen Code, Gemini CLI, and other code agents.  
> 📖 **Full usage manual:** [User Guide](https://github.com/CNCSMonster/pi-approval-mode/blob/main/docs/user-guide.md).

---

## 🌟 Highlights

- **5 Approval Modes**: `manual`, `auto-edit`, `auto`, `yolo`, and `plan` — fresh sessions start in **`auto`** (classifier-driven), changeable anytime.
- **Four-State Permission Rules (`deny` > `ask` > `default` > `allow`)**:
  - **`deny`**: Hard blocking at runtime without modal prompt; takes precedence over everything.
  - **`ask`**: Enforces interactive confirmation modal, overriding auto-approval modes.
  - **`default`**: Delegates to the approval-mode funnel (LLM classifier in `auto`, manual confirmation otherwise); optional — omit it and behavior matches the original tri-state design. *(Note: `default` here is a rule verdict state. The `default` approval mode was renamed to `manual` in v0.3.0, see [FAQ 5.6](docs/user-guide.md#56-where-did-the-default-mode-go).)*
  - **`allow`**: Auto-approves matching operations.
  - **Tool default permission layer**: read-family tools (`read`/`grep`/`find`/`ls`) with no matching rule fast-path inside the workspace and require confirmation outside it (including `~` expansion, except skill directories).
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
  - **Stage 1 (Fast)**: quick check with timeout circuit-breaker (default 1500 ms, configurable).
  - **Stage 2 (Review)**: CoT deep review on flagged actions to eliminate false positives.
  - **Fallback**: Graceful fallback to deterministic heuristic rules if offline or unconfigured.
- **Single-Key Number Shortcuts**: Press `1` ~ `5` to instantly select an action in the approval modal without pressing Enter.
- **3-Tier Permission Memory**:
  - `1`: Allow once
  - `2`: Allow in this session (in-memory)
  - `3`: Always allow in this project (`.pi/approval-rules.json`)
  - `4`: Always allow for this user (``~/.pi/agent/approval-rules.json`)
  - `5`: Block (`Esc` / `q`)
- **Safe Session Resume (`pi -c`) & Ghost Privilege Escalation Defense**:
  - **CLI Wins**: Explicit `--approval-mode` or `--yolo` always takes precedence.
  - **YOLO Safe Downgrade**: If resumed session or reload was left in YOLO mode, automatically downgrades to safe baseline mode to prevent accidental destruction.
  - **Workflow Preservation**: Safely preserves `plan`, `auto`, `auto-edit`, or `manual`.
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
| **`manual`** | `[🛡️ manual]` | **Human review**. Edits, writes, and shell commands each require explicit approval. Read-only tools are auto-approved. |
| **`auto-edit`** | `[📝 auto-edit]` | Auto-approves in-workspace file edits; protected paths, out-of-workspace edits, and shell commands require confirmation. |
| **`auto`** | `[🤖 auto]` | **Classifier-driven** (the startup default). 3-layer filter funnel + 2-stage LLM classifier. Safe operations proceed seamlessly; risky operations are reviewed. Broad allow rules that would defeat the classifier are temporarily stashed while in this mode. |
| **`yolo`** | `[⚡ yolo]` | **Autonomous**. All tool calls execute without prompts (Pi core default). |
| **`plan`** | `[📋 plan]` | **Read-only planning**. Disables `edit` and `write`; limits shell to read-only commands; injects planning instructions. |

> Per-tool, per-mode behavior in detail (including the classifier routing and headless runs): see the [User Guide §2](https://github.com/CNCSMonster/pi-approval-mode/blob/main/docs/user-guide.md#2-approval-modes--tool-behavior).

---

## ⚙️ Configuration

### 1. Mode & Classifier (`approval-config.json`)
Configure the approval mode, classifier model, timeout, and loop detection thresholds globally or per-project:
- Global: `~/.pi/agent/approval-config.json`
- Project: `<workspace>/.pi/approval-config.json`

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

### 2. Four-State Permission Rules (`approval-rules.json`)
Pre-configure rules matching Qwen Code DSL (`deny` > `ask` > `default` > `allow`):
- Global: `~/.pi/agent/approval-rules.json`
- Project: `<workspace>/.pi/approval-rules.json`

> **Note**: `"default"` here is a rule verdict state. The `default` approval mode was renamed to `manual` in v0.3.0, see [FAQ 5.6](docs/user-guide.md#56-where-did-the-default-mode-go).

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
- **`/reload` Session Rule Preservation & Model Hot-Reload**:
  - Running Pi's `/reload` **preserves in-memory session-level approvals** (temporary authorizations from modals survive the reload) and **hot-reloads the model registry**, so a classifier model written to `models.json` or `approval-config.json` takes effect without restarting Pi. A clear status summary is shown when the reload completes.
- **YOLO Safe Downgrade (Ghost Privilege Escalation Defense)**:
  - When reloading (`/reload`) or resuming a session (`pi -c` / `pi -r`), if the resumed session was previously in `yolo` mode, it is **automatically downgraded to the safe baseline mode** (`auto`, or your configured `defaultMode`) with a warning notification.
  - This prevents accidental damage from unintended commands executing autonomously after session re-attachment.
  - Other workflow modes (`plan`, `auto`, `auto-edit`) are faithfully preserved.
  - To force YOLO mode across starts, explicitly pass `pi --yolo` (CLI flags hold absolute highest precedence).

### 6. Project Config Trust Gate
- Project-level `.pi/approval-config.json` and `.pi/approval-rules.json` are loaded only in projects you **trust**, verified through Pi's native trust state (`ctx.isProjectTrusted()`):
  - **Untrusted projects are isolated**: project-level config and rules are completely ignored, falling back to your global configuration with a warning. This blocks a hostile repository from shipping `defaultMode: "yolo"` or `allow: ["Bash(*)"]` to escalate privileges.
  - **How to trust**: launch with the native `pi --approve …` (`-a`) flag, or accept Pi's trust prompt once.

---

## ⌨️ Shortcuts & Commands

- **`Ctrl+Alt+A`**: Cycle through modes (`manual` ➔ `auto-edit` ➔ `auto` ➔ `yolo` ➔ `plan`).
- **`/approval-mode [mode]`**: Switch approval mode.
- **`/classifier-model [provider/model]`**: View or configure classifier model.
- **`/approval-rules [list|clear]`**: View or clear permission rules.

---

## 📄 License

MIT License © 2026 CNCSMonster

---
---

