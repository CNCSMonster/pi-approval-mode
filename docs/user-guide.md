# pi-approval-mode User Guide

English | [简体中文](./user-guide.zh-CN.md)

> Complete user manual for **pi-approval-mode** — multi-tiered tool approval, four-state
> permission rules, and a two-stage LLM safety classifier for
> [Pi Coding Agent](https://github.com/earendil-works/pi).
> For a short overview and feature highlights, see the [README](../README.md).

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

**Dialog interaction & display protections**:
- **Details folding & toggle hotkeys**: Long commands or bulky tool inputs are bounded by a dynamic vertical height budget. Calls spanning $\ge 7$ visual lines fold by default (showing head 3 and tail 2 visual lines), with single extra-long lines protected via head-and-tail character truncation. Press **`v`** or Pi-native **`Ctrl+O`** at any time to toggle between folded and expanded views;
- **Batch progress awareness**: When an assistant turn dispatches multiple tool calls in a batch, the dialog title automatically highlights `(Batch X/Y)` to indicate the current call's position in the sequence;
- **Short terminal degradation**: In small viewports ($\le 28$ rows), the dialog automatically switches to a compact layout, hiding decorative lines and option descriptions to guarantee that choices 1–5 and keybinding hints are fully visible and never clipped.

### 1.4 Switching modes

- **`Ctrl+Alt+A`** — cycle `manual ➔ auto-edit ➔ auto ➔ yolo ➔ plan`;
- **`/approval-mode [mode]`** — jump directly to a mode (Tab-completed, e.g. `/approval-mode auto`).

The current mode is always visible in the status bar (e.g. `[⚖️ auto]`; or `[⚖️ auto | S1⚠️]` if Stage 1 is degraded, see §4.4 and §5.7).

| Mode | Status Badge | Core Positioning |
| :--- | :--- | :--- |
| **`manual`** | `[🛡️ manual]` | **Full human review**: Edits, writes, and shell commands require approval; read tools allowed |
| **`auto-edit`** | `[📝 auto-edit]` | **Auto-edit**: Regular in-workspace edits allowed; protected paths, boundary escapes, and shell require approval |
| **`auto`** | `[⚖️ auto]` | **Classifier-driven (default)**: Two-stage LLM determines allow/block; persists `[⚖️ auto \| S1⚠️]` on S1 degradation |
| **`yolo`** | `[⚡ yolo]` | **Autonomous**: Tools execute without dialog prompts (downgrades to baseline on session resume) |
| **`plan`** | `[📋 plan]` | **Read-only planning**: Disables edit/write, restricts shell to read-only, injects plan prompts |

> ⚠️ **Note**: the `(auto)` after the context usage on status-bar line 2 is **Pi's native
> auto-compaction indicator** (`compaction.enabled`, see Pi's `docs/settings.md`) and has
> nothing to do with this plugin; this plugin's approval-mode badge lives on the extension
> status line (e.g. `[⚖️ auto]`). See §5.7 for details.

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
| `edit` / `write` — **outside workspace** | 🛡️ prompt | 🛡️ prompt | ⚖️ classifier → dialog `*` | ✅ auto | ⛔ blocked |
| `edit` / `write` — **protected path** `*` | 🛡️ prompt | 🛡️ prompt | ⚖️ classifier → dialog `*` | ✅ auto | ⛔ blocked |
| `bash` — read-only (by shell analysis) | 🛡️ prompt | 🛡️ prompt | ⚖️ classifier → dialog | ✅ auto | ✅ auto |
| `bash` — anything else | 🛡️ prompt | 🛡️ prompt | ⚖️ classifier → dialog `*` | ✅ auto | ⛔ blocked |
| read-family, no rule, **inside** workspace | ✅ auto | ✅ auto | ✅ auto | ✅ auto | ✅ auto |
| read-family, no rule, **outside** workspace (except skill dirs `*`) | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog |
| read-family, matched **`default`** rule | 🛡️ prompt | 📝 prompt | ⚖️ classifier → dialog `*` | ✅ auto | ✅ auto |
| matched **`ask`** rule (any mode) | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog | 🛡️ ask dialog |
| matched **`deny`** rule (any mode) | ⛔ silent block | ⛔ silent block | ⛔ silent block | ⛔ silent block | ⛔ silent block |
| matched **`allow`** rule (any mode) | ✅ auto | ✅ auto | ✅ auto | ✅ auto | ✅ auto |

`*` **Notes:**

- **Protected path** = workspace-sensitive locations (`.pi/`, `.git/`, `AGENTS.md`, dotfiles such as `.bashrc` / `.zshrc` / `.profile`, env and keys `.env*` / `id_rsa*` / `id_ed25519*`, credential files `.pypirc` / `.git-credentials`, CLI configs `.config/gh/` / `.config/glab-cli/`, and cloud/cluster definitions `helm/` / `k8s/` / `iam/`). In `auto` these route through the classifier instead of the fast path.
- **Classifier → dialog**: the two-stage LLM classifier reviews the call with its conversation context. If flagged risky, an interactive dialog shows the risk reason before the same `1`–`5` choices; if deemed safe, the call proceeds without any prompt.
- **Skill dirs** `*` = user-level `~/.pi/agent/skills/**` and `~/.agents/skills/**` (always exempt) plus project-level `.pi/skills/**` and `.agents/skills/**` (exempt only when the project is trusted). Explicit `deny` / `ask` rules still win over this whitelist.
- **Read-only `bash`** is decided by a shell state-machine (quotes, redirections, pipes, `&&`/`;` splitting, `$( )` substitution, flag guards for `find`/`git`/`sed`). A single write redirection revokes read-only status. **In `auto` the read-only fast path is retired**: the analysis now only guards `plan` (hard block) and feeds the "static structure" display line of `auto` dialogs — display, not verdict. Every rule-unmatched shell call, `ls` included, goes through the classifier; pin a command back to 0 s with an `allow` rule.
- **Destructive Git Operations**: `git push --force-with-lease` is treated as a safe collaborative operation exempt from high-risk regex fallbacks and judged by the classifier; bare `--force` / `-f` and destructive rewrites are strictly intercepted by deterministic heuristics.

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
| Hard-block destructive git yourself (there is no built-in rule — the classifier judges by common sense) | `"deny": ["Bash(git push *--force*)"]` |
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

In **`auto`** mode, every rule-unmatched shell call (the read-only fast path is retired —
`ls` goes through the classifier too), protected-path edits, and
`default`-routed reads go through a **two-stage LLM review**:

- **Stage 1** — a fast JSON judgment (with a timeout circuit-breaker);
- **Stage 2** — a thinking re-review only when Stage 1 flags, to eliminate false positives;
- decision + human-readable risk reason appear in the dialog (or become a headless denial);
- **Compact Reason Contract**: Prompts enforce concise justifications (strictly under 15 words or 60 characters) to prune verbose rhetoric and lower turn latency.

### 4.2 Configuring `classifierModel`

`~/.pi/agent/approval-config.json`:

```json
{
  "classifierStage1Model": "deepseek/deepseek-flash",
  "classifierStage2Model": "openrouter/anthropic/claude-haiku-5.5",
  "classifierStage1Thinking": "low",
  "classifierStage2Thinking": "low",
  "defaultMode": "auto",
  "classifierTimeoutMs": 1500,
  "classifierStage2TimeoutMs": 4500
}
```

> **Production Recommendation (Benchmark Optimized)**:
> - **Stage 1 (Fast Probe)**: `deepseek/deepseek-flash` with `thinking: "low"` (~400ms latency, fast-paths 80% benign operations within 1500ms budget);
> - **Stage 2 (Deep Review)**: `openrouter/anthropic/claude-haiku-5.5` with `thinking: "low"` (long CoT reliably detects prompt injection attacks, achieving 95% benchmark accuracy);
> - When using dedicated state classifiers (e.g. Jev), Stage 1 thinking must remain `off`.

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
- **Inspect or configure classifier models at runtime**: **`/classifier-model`**
  - **View status**: Run `/classifier-model` with no arguments to inspect the configured value, effective model, fallback reason, and thinking level (`Stage 1 思考` / `Stage 2 思考`) for both Stage 1 (screening) and Stage 2 (review).
  - **Set per-stage models**: `/classifier-model --stage1 <provider/model>` or `/classifier-model --stage2 <provider/model>` (both stages can be specified in one command, e.g. `/classifier-model --stage1 deepseek/deepseek-flash --stage2 deepseek/deepseek-v4-pro`, order-independent).
  - **Set both stages together**: `/classifier-model --both <provider/model>` (writes to shared key and clears stage-specific keys).
  - **Configure thinking level**: `--thinking <level>` (options: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), scoped by `--stage1`, `--stage2`, or `--both`. E.g., `/classifier-model --stage1 deepseek/deepseek-flash --thinking off`, `/classifier-model --stage2 --thinking low`, or `/classifier-model --both --thinking minimal`.
  - **Clear configurations**: `/classifier-model clear` (resets all stages and thinking keys back to builtin defaults and main model); targeted resets are also supported: `/classifier-model clear --stage1` (or `--stage2` / `--both` / `--thinking`, where `clear --thinking` clears thinking keys only).
  - **Help and completions**: `/classifier-model help` shows syntax and examples. Full-cycle Tab completion is supported with mutual-exclusion pruning, metadata display (pricing, reasoning capability, context window), and active model indicators (`✓`); typing `--thinking ` autocompletes across all 7 supported thinking levels.
  - **Migration notes**: Positional syntax `/classifier-model <model>` and `/classifier-model default` has been removed. Please migrate to `--both <model>` and `clear` respectively.
- `defaultMode` sets the startup mode; project-level `.pi/approval-config.json` overrides
  global settings per top-level key (and is only honored in **trusted** projects — see §5.4).

#### 4.2.1 Configuration Topologies and Conflict Governance

The two-stage classifier architecture supports three model specification fields:
1. `classifierModel` (shared base / default general-purpose LLM);
2. `classifierStage1Model` (dedicated Stage 1 screening model, supports general LLMs or state classifiers);
3. `classifierStage2Model` (dedicated Stage 2 deep review model, general-purpose LLM only).

The system recognizes three valid topology patterns:

| Topology | Field Combination | Runtime Resolution & Inheritance |
| :--- | :--- | :--- |
| **Pattern 1: Pure Shared Base** | `classifierModel` only | Both Stage 1 and Stage 2 inherit the shared LLM base |
| **Pattern 2: Stage 1 Override + Base** | `classifierStage1Model` + `classifierModel` | Stage 1 runs its dedicated model; Stage 2 inherits the base |
| **Pattern 3: Independent Per-stage** | `classifierStage1Model` + `classifierStage2Model` | Stage 1 and Stage 2 run dedicated models independently |

**Three-Way Coexistence Conflict Governance (Loud Ignore)**:
When `classifierModel`, `classifierStage1Model`, and `classifierStage2Model` are simultaneously specified in configuration, the system flags an invalid topology conflict and enforces:
- **Loud Explicit Warning**: Emits `console.warn` and a UI notification at startup/reload:
  `⚠️ [ApprovalMode] 检测到分类器模型配置冲突：classifierModel、classifierStage1Model 与 classifierStage2Model 同时存在。处理策略：按 Stage 1 与 Stage 2 专属模型执行，全局 classifierModel ("<val>") 已被就地忽略（未修改磁盘文件）。`
- **Zero Disk Mutation**: Never mutates or overwrites the user's config file on disk; original format and comments are strictly preserved.
- **Bypass Cutoff in Memory**: The base model is deactivated in memory. Stage 1 and Stage 2 strictly execute their dedicated models; if a dedicated model fails, it falls back directly to built-in defaults or the main model, **never penetrating to the ignored base model**.
- **Transparent Status Reporting**: `/classifier-model` explicitly flags the ignored base model:
  `公共底座: 配置值 <model> [⚠️ 冲突已忽略：两阶段均已单独指定，此项未启用]`.

#### 4.2.2 Strict Capability Boundary for State Classifiers

Dedicated state classifiers (e.g., Jev) implement decision protocols without chat completion capabilities:
1. **Screening Boundary**: State classifiers are strictly permitted only for `classifierStage1Model`.
2. **Review & Base Prohibited**: Public base `classifierModel` and `classifierStage2Model` must always be general-purpose LLMs (Stage 2 requires human-readable reasoning; `complete()` must never be invoked on a classifier).
3. **End-to-End Enforcement**:
   - File configuration loading detects classifiers in base config, emits warnings, and blocks Stage 2 inheritance.
   - CLI command `/classifier-model` rejects state classifiers for `--stage2` and `--both`, and autocompletion prunes them for non-Stage 1 options.

#### 4.2.3 Classifier Thinking Configuration and Explicit Observability

Stage 1 and Stage 2 classifiers support independent thinking mode (Reasoning / Thinking) configuration:

- **Thinking Level Vocabulary**: `off` (explicitly disable reasoning), `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. When omitted, it resolves to unset (the `reasoning` parameter is omitted from model completion calls, honoring provider defaults).
- **Validation & Safe Fallback (Production Safety First)**:
  - **Invalid Enum**: If an unaccepted string is supplied, a warning is emitted at startup/reload and the stage safely falls back to unset.
  - **Unsupported Level**: If a level is valid but unsupported by the chosen model (e.g. `reasoning: false` models or state classifiers only support `off`), a warning listing supported levels is emitted and the stage safely falls back to unset.
  - The fallback mechanism ensures classifier pipeline availability is never broken by invalid thinking options.
- **Full-Chain Explicit Observability**:
  - **Startup & Reload Logging**: On startup and `/reload`, the extension logs `[ApprovalMode] 分类器思考配置 effective: stage1=... stage2=...` with explicit source annotations (`配置`, `provider 默认`, or fallback reasons such as `未指定(原 low 不受支持, 已回退)`).
  - **Status Inspection View**: Running `/classifier-model` reports explicit `Stage 1 思考` and `Stage 2 思考` status lines, including configured values, effective values, and fallback reasons.

### 4.3 Timeout & graceful degradation

- Stage 1 runs under `classifierTimeoutMs` (default **1500 ms**). Raise it if your model is slow;
- if the classifier is **unavailable** (unconfigured, unreachable, repeatedly timing out),
  `auto` mode degrades to the **deterministic heuristic rules** — dangerous patterns
  (destructive `rm`, `curl | sh`, force-push, credential paths …) still block;
- a *heuristic allow* therefore does **not** prove the classifier answered — see §5.2.

### 4.4 Stage 1 Health Visibility & Troubleshooting

Stage 1 fast screening is engineered to allow over 95% of benign tool calls in ~200ms with negligible token overhead. When Stage 1 encounters a failure (timeout, network drop, upstream error, or invalid JSON response):

1. **Non-blocking Invariant**: The workflow automatically cascades to Stage 2 deep reasoning. **The Agent's tool execution is never blocked**, and the shared unavailable circuit breaker counter is not incremented;
2. **Persistent Status Bar Visibility**: The status bar badge automatically transitions from `[⚖️ auto]` to **`[⚖️ auto | S1⚠️]`**, giving ambient awareness without log scouring;
3. **Escalated Warning**: If Stage 1 consecutively fails **5 times** (indicating the model is persistently offline, quota-exhausted, or under-configured), a dedicated notification is raised warning that tool execution latency and token cost have increased;
4. **Self-Healing & Reset**: Once Stage 1 responds successfully, the badge reverts back to `[⚖️ auto]` and consecutive failure counters reset to zero;
5. **Troubleshooting Steps**:
   - Run `/classifier-model` to inspect Stage 1 consecutive failure count and recent failure reason (`lastFailureReason`);
   - Run `/classifier-model --stage1 <provider/model>` to switch to a more responsive, reliable model;
   - If failures are due to network latency, raise `classifierTimeoutMs` in `~/.pi/agent/approval-config.json`.

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

### 5.7 Is status-bar `(auto)` the same as `[⚖️ auto]`?

No — different semantics, different location, different owner:

| Display | Meaning | Controlled by |
| :--- | :--- | :--- |
| Line 2, `0.0%/262k (auto)` | **Pi native** auto-compaction indicator: shown when the context is auto-compacted as it nears the window limit | `compaction.enabled` in `settings.json` (built into Pi) |
| Extension status line, `[⚖️ auto]` | **This plugin's** approval-mode badge (Healthy): ⚖️ stands for the two-stage LLM classifier with Stage 1 fast screening online | `/approval-mode` command, `Ctrl+Alt+A`, `--approval-mode` flag |
| Extension status line, `[⚖️ auto \| S1⚠️]` | **This plugin's** approval-mode badge (Stage 1 Degraded): Stage 1 is offline or failing; Stage 2 deep review handles calls. Agent is unblocked, but tool latency is higher | Plugin runtime health state machine (active on degraded, restores on success) |

Pi deliberately ships no approval mechanism of its own (the official docs state it
"intentionally does not include ... permission popups"), so all approval capability comes
from this plugin. The two "auto"s belong to entirely different subsystems and merely share
a word.

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

