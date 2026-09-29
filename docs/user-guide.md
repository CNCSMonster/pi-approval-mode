# pi-approval-mode User Guide

English | [中文文档](#中文文档)

> Complete user manual for **pi-approval-mode** — multi-tiered tool approval, four-state
> permission rules, and a two-stage LLM safety classifier for
> [Pi Coding Agent](https://github.com/earendil-works/pi).
> For a short overview and feature highlights, see the [README](./README.md).

---

## 1. Quickstart

### 1.1 Install

```bash
pi install git:github.com/CNCSMonster/pi-approval-mode
```

Update anytime with `pi update`. The plugin activates automatically — no core modification required.

### 1.2 Your first run (`auto` mode)

On a fresh install the plugin starts in **`auto`** (classifier-driven) mode — the
practical default for day-to-day work:

- **Read-only tools** (`read` / `grep` / `find` / `ls`) inside your workspace are auto-approved — investigation flows without friction.
- **Regular in-workspace edits** pass automatically; prompts still appear for **classifier-flagged shell commands, protected-path changes, out-of-workspace reads, and anything matching an `ask` rule**.
- Prefer a confirmation for every change? Switch to **`manual`** with `/approval-mode manual` (§1.4).

### 1.3 The approval dialog

Every dialog offers five actions — **press the number key `1`–`5` for instant selection** (no Enter needed):

| Key | Action | Scope |
| :--- | :--- | :--- |
| `1` | Allow once | This call only |
| `2` | Always allow (session) | In-memory, this session |
| `3` | Always allow in this project | Persisted to `<workspace>/.pi/approval-rules.json` |
| `4` | Always allow for this user | Persisted to `~/.pi/agent/approval-rules.json` |
| `5` / `Esc` | Block | The model receives a denial feedback and adapts |

Options `2`–`4` write an `allow` rule at the corresponding tier, so the same action never bothers you again at that scope.

### 1.4 Switching modes

- **`Ctrl+Alt+A`** — cycle `manual ➔ auto-edit ➔ auto ➔ yolo ➔ plan`;
- **`/approval-mode [mode]`** — jump directly to a mode (Tab-completed, e.g. `/approval-mode auto`).

The current mode is always visible in the status bar (e.g. `[🤖 auto]`).

### 1.5 Suggested next step

Read **§2** to know exactly what each mode does per tool, then **§4** if you want the
LLM classifier active in `auto` mode.

---

## 2. Approval Modes × Tool Behavior

### 2.1 Decision pipeline

Every tool call passes these stages **in order**; the first matching stage decides:

```
loop breaker ─▶ deny rules ─▶ ask rules ─▶ default rules / allow rules ─▶ tool default layer ─▶ mode funnel
```

1. **Loop breaker** — repeated identical failing calls are circuit-broken (hard limit blocks even interactively).
2. **`deny` rule** — silent hard block, no dialog, in every mode.
3. **`ask` rule** — dialog is **forced**, overriding every auto-approve mode (including `yolo`).
4. **`default` rule** — delegates the decision to the *mode funnel* (this is the "pay-as-you-go" verdict: without `default` rules, behavior matches the classic three-state design).
5. **`allow` rule** — auto-approved in every mode — **except in `auto`**: broad allow rules that would defeat the classifier (tool-level `Bash`, interpreter wildcards like `Bash(npx *)`) are temporarily stashed on entry and return when you leave `auto`.
6. **Tool default layer** (read-family tools only, when no rule matched) — inside the workspace: auto-approved; outside the workspace (including `~` expansion): interactive confirmation **in every mode, `yolo` included**.
7. **Mode funnel** — the per-mode behavior described by the matrix below.

### 2.2 The matrix

The five modes form an automation ramp — `manual → auto-edit → auto → yolo` (`plan` is orthogonal). Modes are columns; the state of the call is the row. `*`-marked cells are explained below the table.

| Call | `manual` | `auto-edit` | `auto` | `yolo` | `plan` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `edit` / `write` — regular workspace file | 🛡️ prompt | ✅ auto | ✅ auto | ✅ auto | ⛔ blocked |
| `edit` / `write` — **protected path** `*` | 🛡️ prompt | ✅ auto | 🤖 classifier → dialog `*` | ✅ auto | ⛔ blocked |
| `bash` — read-only (by shell analysis) | 🛡️ prompt | 🛡️ prompt | ✅ auto | ✅ auto | ✅ auto |
| `bash` — anything else | 🛡️ prompt | 🛡️ prompt | 🤖 classifier → dialog `*` | ✅ auto | ⛔ blocked |
| read-family, no rule, **inside** workspace | ✅ auto | ✅ auto | ✅ auto | ✅ auto | ✅ auto |
| read-family, no rule, **outside** workspace | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog |
| read-family, matched **`default`** rule | 🛡️ prompt | 📝 prompt | 🤖 classifier → dialog `*` | ✅ auto | ✅ auto |
| matched **`ask`** rule (any mode) | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog |
| matched **`deny`** rule (any mode) | ⛔ silent block | ⛔ silent block | ⛔ silent block | ⛔ silent block | ⛔ silent block |
| matched **`allow`** rule (any mode) | ✅ auto | ✅ auto | ✅ auto | ✅ auto | ✅ auto |

`*` **Notes:**

- **Protected path** = workspace-sensitive locations (`.pi/`, `.git/`, `AGENTS.md`, dotfiles such as `.bashrc` / `.zshrc` / `.profile`, `.env*`, `id_rsa*`). In `auto` these route through the classifier instead of the fast path.
- **Classifier → dialog**: the two-stage LLM classifier reviews the call with its conversation context. If flagged risky, an interactive dialog shows the risk reason before the same `1`–`5` choices; if deemed safe, the call proceeds without any prompt.
- **Read-only `bash`** is decided by a shell state-machine (quotes, redirections, pipes, `&&`/`;` splitting, `$( )` substitution, flag guards for `find`/`git`/`sed`). A single write redirection revokes read-only status.

### 2.3 Headless (non-interactive) runs

Without a UI (`pi -p …`), no dialog can be shown, so every "prompt" outcome becomes an
English denial message instead — the model is told why and how to proceed safely:

- `ask` rule → `[Permission: ask] Rule … requires interactive confirmation …`
- classifier flag → `[Auto Mode] … blocked by the safety classifier …`
- manual-mode prompts → `[Manual Mode] … no interactive UI …`
- loop hard limit → `[Circuit Breaker] … do not retry …`

In `auto` headless runs, a classifier *availability* problem silently falls back to the
deterministic heuristic rules (fail-safe: risky patterns still block; see §4.3).

---

## 3. Rules Cookbook

### 3.1 DSL syntax

```
Tool(specifier)
```

| Meta-category | Covers | Specifier examples |
| :--- | :--- | :--- |
| `Read` | `read`, `grep`, `find`, `ls` (and aliases) | `Read(/src/**)`, `Read(.env*)`, `Read(~/.ssh/**)` |
| `Edit` | `edit`, `write` | `Edit(/package.json)`, `Edit(./config/**)` |
| `Bash` | `bash` | `Bash(git status)`, `Bash(git push *)`, `Bash(sudo *)` |

**Scope prefixes** (applied to the specifier):

| Prefix | Means |
| :--- | :--- |
| `//…` | Absolute filesystem path (`//etc/**`) |
| `~/…` | Home directory (`~/notes/**`) |
| `/…` | Project-root-relative (`/src/**`) |
| `./…` or bare | Workspace/cwd-relative (`Read(.env*)`, `Edit(./config/**)`) |

### 3.2 Verdict priority & tiers

$$\text{Deny} > \text{Ask} > \text{Default} > \text{Allow}$$

Rules are pooled **union-style** across three persistence tiers (session / project / user).
**Verdict priority strictly trumps tier** — a user-level `deny` always beats a project-level
`allow`. Tiers only decide *where a rule is stored and how long it lives*.

### 3.3 Recipe book

```jsonc
// ~/.pi/agent/approval-rules.json  (user-global)
{
  "deny":    ["Read(~/.ssh/**)", "Bash(git push *--force*)"],  // absolute, silent
  "ask":     ["Bash(git push *)", "Edit(/package.json)"],      // always confirm
  "default": ["Read(./secrets/**)"],                           // hand to the mode funnel
  "allow":   ["Bash(git status)", "Bash(git diff *)"]          // never bother me
}
```

| Goal | Recipe |
| :--- | :--- |
| Protect credentials everywhere | `"deny": ["Read(.env*)", "Read(~/.ssh/**)"]` |
| Force **classifier audit** for sensitive reads in `auto` | `"default": ["Read(./secrets/**)"]` — the read goes through the classifier instead of the workspace fast path |
| Silence routine git commands | `"allow": ["Bash(git status)", "Bash(git diff *)"]` |
| Always confirm production-bound pushes | `"ask": ["Bash(git push *)"]` |
| Let a mode decide (opt-in advanced behavior) | `"default": [...]` — omit `default` rules entirely and behavior stays classic three-state |

### 3.4 Inspecting rules: `/approval-rules`

- `/approval-rules` — lists all four pools with counts and origin (session/project/user),
  including shadow/conflict warnings when a lower-severity rule can never win;
- `/approval-rules clear` — resets rule pools (with confirmation).

Dialog choices `2`/`3`/`4` (§1.3) are the ergonomic way to add rules — this command is for review and maintenance.

---

## 4. Classifier & Model Setup

### 4.1 What the classifier does

In **`auto`** mode, risky-looking calls (non-read-only shell, protected-path edits,
`default`-routed reads) go through a **two-stage LLM review**:

- **Stage 1** — a fast JSON judgment (with a timeout circuit-breaker);
- **Stage 2** — a thinking re-review only when Stage 1 flags, to eliminate false positives;
- decision + human-readable risk reason appear in the dialog (or become a headless denial).

### 4.2 Configuring `classifierModel`

`~/.pi/agent/approval-config.json`:

```json
{
  "classifierModel": "<provider>/<model>",
  "defaultMode": "auto",
  "classifierTimeoutMs": 1500
}
```

- **`<provider>/<model>`** must exist in Pi's model registry (`~/.pi/agent/models.json`).
  Pick any cheap, fast model — the classifier only answers a small JSON question:

```jsonc
// ~/.pi/agent/models.json (excerpt)
"providers": {
  "my-proxy": {
    "api": "openai-completions",
    "apiKey": "$MY_PROXY_API_KEY",        // env reference — never paste keys into files
    "baseUrl": "https://example.com/v1",
    "models": [{ "id": "fast-model", "contextWindow": 128000, ... }]
  }
}
```

- **Never store API keys in config files.** Use the `$ENV_VAR` reference form above and
  export the variable in the environment that launches Pi.
- Inspect or change the active classifier at runtime with **`/classifier-model [provider/model]`**.
- `defaultMode` sets the startup mode; project-level `.pi/approval-config.json` overrides
  global settings per top-level key (and is only honored in **trusted** projects — see §5.4).

### 4.3 Timeout & graceful degradation

- Stage 1 runs under `classifierTimeoutMs` (default **1500 ms**). Raise it if your model is slow;
- if the classifier is **unavailable** (unconfigured, unreachable, repeatedly timing out),
  `auto` mode degrades to the **deterministic heuristic rules** — dangerous patterns
  (destructive `rm`, `curl | sh`, force-push, credential paths …) still block;
- a *heuristic allow* therefore does **not** prove the classifier answered — see §5.2.

---

## 5. FAQ & Troubleshooting

### 5.1 Pi reports "No API key found"

The model provider reads its key from an environment variable (the `$VAR` reference in
`models.json`). The variable did not reach the Pi process. Checklist:

1. Is the variable set in **the shell that launches Pi**? (`echo ${VAR:+SET}` — print length, not the value.)
2. Interactive shells that rebuild their environment on startup (frameworks, version managers,
   `mise`/`direnv`-style hooks that re-export variables per prompt) can drop variables that
   were injected earlier. **Launch Pi and the export on the same command line**:
   ```bash
   export MY_PROXY_API_KEY=$(cat /path/to/credfile) && pi …
   ```
3. Verify inside the running process: `/proc/<pid>/environ` should contain the variable.

### 5.2 "The classifier allows everything" — or does it?

A permissive outcome has three possible causes; they are distinguishable:

1. **The call was legitimately allowed** — dialog absent, call executed;
2. **The classifier was unavailable** and the heuristic fallback allowed it (check the
   classifier warning notifications; temporarily raise `classifierTimeoutMs` or switch to a
   faster model);
3. **The call never reached the plugin** — the model refused before issuing a tool call
   (see §5.3).

A reliable tell: a genuine classifier verdict carries a **natural-language risk reason**
in the dialog or denial message; heuristic fallback messages are template-shaped.

### 5.3 Model refuses vs. plugin blocks

Two different defense layers produce two different experiences:

| | Model self-refusal | Plugin gate |
| :--- | :--- | :--- |
| Visible as | Plain apologetic text, **no tool call executed** | Dialog, or a structured `Blocked`/`[Mode] …` message after a tool call |
| Who decided | The conversation model's own safety training | Rule engine / classifier / mode matrix |
| Bypassing | — | Retrying the same call re-enters the same gate; the denial feedback tells the model not to restructure around it |

If you *need* a tool call to actually reach the gate for testing, phrase the request as a
plain tool action (models often pre-refuse composite "read-and-transmit" style requests
before ever emitting a tool call).

### 5.4 My project config is ignored

Almost certainly the **trust gate**: project-level `.pi/approval-config.json` and
`.pi/approval-rules.json` are only honored in projects you trust. Untrusted (e.g. freshly
cloned) repositories fall back to your global config with a warning — this blocks a hostile
repo from shipping `defaultMode: "yolo"` or `allow: ["Bash(*)"]`. Trust the project
(`pi --approve …` or the trust prompt) to activate its local config.

### 5.5 Where did my temporary approval go?

Approval `2` (session) lives in memory only and ends with the session; `/reload` **preserves**
session rules (and hot-reloads models). Use `3` (project) or `4` (user) for anything that
should survive. When resuming an old session that was left in `yolo`, the plugin **downgrades
to the safe baseline (`auto`, or your configured `defaultMode`) automatically** — pass `pi --yolo` explicitly if you really mean it.

### 5.6 Where did the `default` mode go?

It was renamed to **`manual`** (v0.3.0). Once fresh sessions started in `auto`, the name
`default` stopped being the default — and it collided with the rules' fourth-state verdict
`default` (which is unchanged). Old values are accepted transparently: `defaultMode:
"default"` in config, `--approval-mode default`, and old session states all map to
`manual` automatically.

---

## 6. Development & Testing

```bash
git clone https://github.com/CNCSMonster/pi-approval-mode.git
cd pi-approval-mode
npm test        # node --test --experimental-strip-types tests/*.ts — no install step needed
```

Layout:

- `extensions/` — the plugin sources (`approval-mode.ts` is the entry registered in `package.json`);
- `tests/` — the full suite (rule engine, disposition matrix, classifier projection,
  shell analyzer, loop detector, policy consistency, trust gate, reload lifecycle,
  dangerous-allow guard, mode aliasing);
- `README.md` / `docs/user-guide.md` — **synced copies**; each carries a source comment
  pointing at the authoritative document, edit there, not here.

Test names are organized by behavior ("four-state priority", "read gate", "pay-as-you-go"),
so `grep`ing the suite is the fastest way to find the authoritative answer for any
edge case of the matrix in §2.

---

<a name="中文文档"></a>
# pi-approval-mode 用户指南（中文）

[English](#pi-approval-mode-user-guide) | 中文

> **pi-approval-mode** 是 [Pi Coding Agent](https://github.com/earendil-works/pi) 的
> 多级工具审批、四态权限规则与两阶段 LLM 安全分类器插件的**完整用户手册**。
> 简介与功能亮点见 [README](./README.md)。

---

## 1. 快速上手

### 1.1 安装

```bash
pi install git:github.com/CNCSMonster/pi-approval-mode
```

随时 `pi update` 更新。插件自动激活，**零核心改动**。

### 1.2 首次运行（`auto` 模式）

全新安装后插件以 **`auto`**（分类器驱动）模式启动——日常工作的实用默认：

- 工作区内的**只读工具**（`read` / `grep` / `find` / `ls`）自动放行——排查问题零打扰；
- **工作区内常规编辑**自动通过；弹窗仍会出现于**分类器拦截的 Shell 命令、受保护路径修改、工作区外读取，以及命中 `ask` 规则的操作**；
- 想每笔变更都确认？`/approval-mode manual` 切换到 **`manual`**（§1.4）。

### 1.3 审批对话框

每个对话框提供五种动作——**直接按数字键 `1`–`5` 瞬间选择**（无需回车）：

| 键 | 动作 | 作用域 |
| :--- | :--- | :--- |
| `1` | 允许本次执行 | 仅此一次 |
| `2` | 始终允许（本会话） | 内存态，随会话结束失效 |
| `3` | 始终允许在本项目 | 持久化到 `<workspace>/.pi/approval-rules.json` |
| `4` | 始终允许对该用户 | 持久化到 `~/.pi/agent/approval-rules.json` |
| `5` / `Esc` | 拒绝执行 | 向模型反馈拒绝原因，模型自行调整 |

选择 `2`–`4` 会在对应层级写入一条 `allow` 规则，同款操作以后在该范围内不再打扰你。

### 1.4 切换模式

- **`Ctrl+Alt+A`** — 循环切换 `manual ➔ auto-edit ➔ auto ➔ yolo ➔ plan`；
- **`/approval-mode [mode]`** — 直达指定模式（支持 Tab 补全，如 `/approval-mode auto`）。

当前模式常驻状态栏（如 `[🤖 auto]`）。

### 1.5 建议的下一步

先读 **§2** 弄清每个模式对各类工具的确切行为；要在 `auto` 模式启用分类器请读 **§4**。

---

## 2. 审批模式 × 工具行为

### 2.1 裁决管线

每次工具调用**按顺序**经过以下阶段，首个命中者裁决：

```
死循环熔断 ─▶ deny 规则 ─▶ ask 规则 ─▶ default / allow 规则 ─▶ 工具默认权限层 ─▶ 模式漏斗
```

1. **死循环熔断** — 连续同款失败调用被熔断（触达硬上限即使交互态也直接阻断）。
2. **`deny` 规则** — 一切模式下静默硬阻断，不弹窗。
3. **`ask` 规则** — **强制弹窗**，压倒一切免审模式（含 `yolo`）。
4. **`default` 规则** — 把裁决交给*模式漏斗*（这就是"按需付费"裁决：不配 `default` 规则，行为与经典三态一致）。
5. **`allow` 规则** — 一切模式下自动放行——**`auto` 模式例外**：宽到足以绕过分类器的 allow 规则（工具级 `Bash`、解释器通配如 `Bash(npx *)`）进入 `auto` 时被暂存剥离，退出时归位。
6. **工具默认权限层**（仅读类工具、未命中规则时）— 工作区内自动放行；工作区外（含 `~` 展开）**包括 `yolo` 在内的一切模式**都需人工确认。
7. **模式漏斗** — 即下表所述的分模式行为。

### 2.2 行为矩阵

五个模式构成自动化梯度——`manual → auto-edit → auto → yolo`（`plan` 正交）。模式是列、调用状态是行。带 `*` 的单元格见表下注释。

| 调用 | `manual` | `auto-edit` | `auto` | `yolo` | `plan` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `edit` / `write` — 工作区常规文件 | 🛡️ 弹窗 | ✅ 自动 | ✅ 自动 | ✅ 自动 | ⛔ 阻断 |
| `edit` / `write` — **受保护路径** `*` | 🛡️ 弹窗 | ✅ 自动 | 🤖 分类器 → 弹窗 `*` | ✅ 自动 | ⛔ 阻断 |
| `bash` — 只读（词法分析判定） | 🛡️ 弹窗 | 🛡️ 弹窗 | ✅ 自动 | ✅ 自动 | ✅ 自动 |
| `bash` — 其余命令 | 🛡️ 弹窗 | 🛡️ 弹窗 | 🤖 分类器 → 弹窗 `*` | ✅ 自动 | ⛔ 阻断 |
| 读类、无规则、**工作区内** | ✅ 自动 | ✅ 自动 | ✅ 自动 | ✅ 自动 | ✅ 自动 |
| 读类、无规则、**工作区外** | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 |
| 读类、命中 **`default`** 规则 | 🛡️ 弹窗 | 📝 弹窗 | 🤖 分类器 → 弹窗 `*` | ✅ 自动 | ✅ 自动 |
| 命中 **`ask`** 规则（任意模式） | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 | 🛡️ ask 弹窗 |
| 命中 **`deny`** 规则（任意模式） | ⛔ 静默阻断 | ⛔ 静默阻断 | ⛔ 静默阻断 | ⛔ 静默阻断 | ⛔ 静默阻断 |
| 命中 **`allow`** 规则（任意模式） | ✅ 自动 | ✅ 自动 | ✅ 自动 | ✅ 自动 | ✅ 自动 |

`*` **注：**

- **受保护路径** = 工作区敏感位置（`.pi/`、`.git/`、`AGENTS.md`、`.bashrc` / `.zshrc` / `.profile` 等点文件、`.env*`、`id_rsa*`）。`auto` 模式下这些路径不走快路径，改走分类器。
- **分类器 → 弹窗**：两阶段 LLM 分类器结合对话上下文研判该调用。判为有风险则弹窗展示风险理由，之后仍是 `1`–`5` 选择；判为安全则无感放行。
- **只读 `bash`** 由 Shell 状态机判定（引号、重定向、管道、`&&`/`;` 切分、`$( )` 替换、`find`/`git`/`sed` 参数守卫）。任何一处写入重定向即一票否决只读资格。

### 2.3 无头（非交互）运行

没有 UI 时（`pi -p …`）无法弹窗，一切"需人工"结局改为**英文拒绝消息**——告诉模型原因与安全出路：

- `ask` 规则 → `[Permission: ask] Rule … requires interactive confirmation …`
- 分类器拦截 → `[Auto Mode] … blocked by the safety classifier …`
- manual 模式需人工 → `[Manual Mode] … no interactive UI …`
- 死循环硬上限 → `[Circuit Breaker] … do not retry …`

`auto` 无头运行中，分类器**不可用**时会静默回落到确定性启发式规则（失败安全：高危模式仍会拦截，见 §4.3）。

---

## 3. 规则 Cookbook

### 3.1 DSL 语法

```
Tool(specifier)
```

| 宏分类 | 覆盖工具 | specifier 示例 |
| :--- | :--- | :--- |
| `Read` | `read`、`grep`、`find`、`ls`（及别名） | `Read(/src/**)`、`Read(.env*)`、`Read(~/.ssh/**)` |
| `Edit` | `edit`、`write` | `Edit(/package.json)`、`Edit(./config/**)` |
| `Bash` | `bash` | `Bash(git status)`、`Bash(git push *)`、`Bash(sudo *)` |

**作用域前缀**（加在 specifier 上）：

| 前缀 | 含义 |
| :--- | :--- |
| `//…` | 绝对文件系统路径（`//etc/**`） |
| `~/…` | 家目录（`~/notes/**`） |
| `/…` | 项目根相对（`/src/**`） |
| `./…` 或裸写 | 工作区/当前目录相对（`Read(.env*)`、`Edit(./config/**)`） |

### 3.2 裁决优先级与层级

$$\text{Deny} > \text{Ask} > \text{Default} > \text{Allow}$$

规则跨三个持久化层级（会话 / 项目 / 用户）**并集成池**。**裁决类型优先级严格高于层级**——
用户层的 `deny` 永远压死项目层的 `allow`。层级只决定规则**存在哪、活多久**，不决定谁胜出。

### 3.3 配方手册

```jsonc
// ~/.pi/agent/approval-rules.json  （用户全局）
{
  "deny":    ["Read(~/.ssh/**)", "Bash(git push *--force*)"],  // 绝对底线，静默拦截
  "ask":     ["Bash(git push *)", "Edit(/package.json)"],      // 永远人工确认
  "default": ["Read(./secrets/**)"],                           // 交给审批模式漏斗
  "allow":   ["Bash(git status)", "Bash(git diff *)"]          // 永不打扰
}
```

| 目标 | 配方 |
| :--- | :--- |
| 全局保护凭据文件 | `"deny": ["Read(.env*)", "Read(~/.ssh/**)"]` |
| `auto` 下强制敏感读取走**分类器审计** | `"default": ["Read(./secrets/**)"]` — 该读取不走工作区快路径，改入分类器 |
| 静音日常 git 命令 | `"allow": ["Bash(git status)", "Bash(git diff *)"]` |
| 发布类推送永远人工确认 | `"ask": ["Bash(git push *)"]` |
| 交给模式裁决（选择性启用高级行为） | `"default": [...]` — 完全不配 `default` 规则即保持经典三态 |

### 3.4 查看与维护：`/approval-rules`

- `/approval-rules` — 列出四池规则、计数与来源（会话/项目/用户），并展示影子/冲突警告
  （低severity 规则永远无法生效时提示）；
- `/approval-rules clear` — 清空规则池（需确认）。

审批弹窗的 `2`/`3`/`4`（§1.3）是加规则的顺手方式，本命令用于**审查与维护**。

---

## 4. 分类器与模型配置

### 4.1 分类器做什么

**`auto`** 模式下，观感有风险的调用（非只读 Shell、受保护路径编辑、`default` 路由的读取）
进入**两阶段 LLM 研判**：

- **Stage 1** — 极速 JSON 判定（带超时熔断）；
- **Stage 2** — 仅当 Stage 1 拦截时启动思维链复核，消除误报；
- 结论与可读的风险理由进入弹窗（无头模式下转为拒绝消息）。

### 4.2 配置 `classifierModel`

`~/.pi/agent/approval-config.json`：

```json
{
  "classifierModel": "<provider>/<model>",
  "defaultMode": "auto",
  "classifierTimeoutMs": 1500
}
```

- **`<provider>/<model>`** 必须存在于 Pi 模型注册表（`~/.pi/agent/models.json`）。
  挑便宜快的小模型即可——分类器只回答一个小小的 JSON 问题：

```jsonc
// ~/.pi/agent/models.json（节选）
"providers": {
  "my-proxy": {
    "api": "openai-completions",
    "apiKey": "$MY_PROXY_API_KEY",        // env 引用——绝不要把明文 key 写进文件
    "baseUrl": "https://example.com/v1",
    "models": [{ "id": "fast-model", "contextWindow": 128000, ... }]
  }
}
```

- **切勿在配置文件里存 API key**。用上面的 `$ENV_VAR` 引用形式，在启动 Pi 的环境里导出变量。
- 运行时查看或更换分类器：**`/classifier-model [provider/model]`**。
- `defaultMode` 设定启动模式；项目级 `.pi/approval-config.json` 按顶层键整体覆盖全局
  （且仅在**受信任**项目生效——见 §5.4）。

### 4.3 超时与优雅降级

- Stage 1 受 `classifierTimeoutMs` 约束（默认 **1500 ms**）；模型慢就调大；
- 分类器**不可用**（未配置、连不上、反复超时）时，`auto` 模式回落到**确定性启发式规则**——
  破坏性 `rm`、`curl | sh`、force-push、凭据路径等高危模式依然拦截；
- 因此启发式放行**不等于**分类器真的回答过——区分方法见 §5.2。

---

## 5. 常见问题与排查

### 5.1 Pi 报 "No API key found"

模型 provider 从环境变量读 key（即 `models.json` 里的 `$VAR` 引用）。该变量没有到达 Pi 进程。排查清单：

1. **启动 Pi 的那个 shell** 里变量在吗？（`echo ${VAR:+SET}`——只看长度不打印值。）
2. 启动时会重建环境的交互 shell（各类框架、版本管理器、`mise`/`direnv` 式每 prompt
   重新导出的钩子）可能洗掉早先注入的变量。**把 export 与 Pi 启动放在同一命令行**：
   ```bash
   export MY_PROXY_API_KEY=$(cat /path/to/credfile) && pi …
   ```
3. 在运行中的进程里验证：`/proc/<pid>/environ` 应包含该变量。

### 5.2 "分类器好像全放行"——真是这样吗？

宽松结局有三种成因，可以区分：

1. **调用确实被判安全** —— 无弹窗、调用执行；
2. **分类器不可用**、启发式回落放行（看分类器告警通知；临时调大 `classifierTimeoutMs` 或换更快模型）；
3. **调用根本没到插件** —— 模型在发出工具调用之前就自我拒绝了（见 §5.3）。

可靠判据：**真实的分类器结论自带自然语言风险理由**（弹窗或拒绝消息里）；启发式回落的文案是模板句式。

### 5.3 模型拒绝 vs 插件拦截

两道防线、两种体验：

| | 模型自我拒绝 | 插件门禁 |
| :--- | :--- | :--- |
| 表现 | 一段抱歉的纯文本，**没有任何工具调用发生** | 弹窗，或工具调用之后结构化的 `Blocked` / `[模式] …` 消息 |
| 谁裁决的 | 对话模型自身的安全训练 | 规则引擎 / 分类器 / 模式矩阵 |
| 绕过 | — | 重试同一调用会再次进入同一门禁；拒绝反馈也明确告知模型不得换路径绕行 |

若测试中*需要*调用真的进入门禁，把请求措辞成朴素的工具动作即可（模型对"读取并外发"
这类复合请求常常在发出工具调用之前就先拒绝）。

### 5.4 为什么项目配置没生效？

几乎可以肯定撞上了**信任闸**：项目级 `.pi/approval-config.json` 与 `.pi/approval-rules.json`
只在受信任项目中生效。不受信任（如刚克隆的）仓库回落到全局配置并告警——这挡住了恶意仓库
自带 `defaultMode: "yolo"` 或 `allow: ["Bash(*)"]` 提权。用 `pi --approve …` 或信任弹窗
信任该项目后，其本地配置即生效。

### 5.5 我的临时授权去哪了？

审批 `2`（会话级）只在内存里，随会话结束消失；`/reload` **会保留**会话级规则
（并热载模型）。想留久用 `3`（项目级）或 `4`（用户级）。恢复遗留在 `yolo` 状态的旧会话时，
插件会**自动降级回安全基线（`auto`，或你配置的 `defaultMode`）**——真要全自动请显式 `pi --yolo`。

### 5.6 `default` 模式哪去了？

v0.3.0 起更名为 **`manual`**。新会话默认 `auto` 后，`default` 这个名字已名不副实，且与规则四态判定 `default`（语义不变）撞名。旧值透明兼容：配置里的 `defaultMode: "default"`、`--approval-mode default` 与历史会话状态都会自动映射为 `manual`。

---

## 6. 开发与测试

```bash
git clone https://github.com/CNCSMonster/pi-approval-mode.git
cd pi-approval-mode
npm test        # node --test --experimental-strip-types tests/*.ts —— 无需安装依赖
```

目录结构：

- `extensions/` — 插件源码（`approval-mode.ts` 是 `package.json` 注册的入口）；
- `tests/` — 全量测试（规则引擎、处置矩阵、分类器投影、Shell 分析器、死循环检测、
  策略一致性、信任闸、reload 生命周期、危险 allow 护栏、模式别名）；
- `README.md` / `docs/user-guide.md` — **同步副本**；文件头有指向权威文档的来源注释，
  改文档请去源头改。

测试名按行为组织（"四态优先级"、"读取门禁"、"按需付费"），所以 `grep` 测试套件是
查证 §2 矩阵任何边界情形最快的方式。
