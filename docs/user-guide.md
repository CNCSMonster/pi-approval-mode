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

### 1.4 Switching modes

- **`Ctrl+Alt+A`** — cycle `manual ➔ auto-edit ➔ auto ➔ yolo ➔ plan`;
- **`/approval-mode [mode]`** — jump directly to a mode (Tab-completed, e.g. `/approval-mode auto`).

The current mode is always visible in the status bar (e.g. `[⚖️ auto]`).

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

- **Protected path** = workspace-sensitive locations (`.pi/`, `.git/`, `AGENTS.md`, dotfiles such as `.bashrc` / `.zshrc` / `.profile`, `.env*`, `id_rsa*`). In `auto` these route through the classifier instead of the fast path.
- **Classifier → dialog**: the two-stage LLM classifier reviews the call with its conversation context. If flagged risky, an interactive dialog shows the risk reason before the same `1`–`5` choices; if deemed safe, the call proceeds without any prompt.
- **Skill dirs** `*` = user-level `~/.pi/agent/skills/**` and `~/.agents/skills/**` (always exempt) plus project-level `.pi/skills/**` and `.agents/skills/**` (exempt only when the project is trusted). Explicit `deny` / `ask` rules still win over this whitelist.
- **Read-only `bash`** is decided by a shell state-machine (quotes, redirections, pipes, `&&`/`;` splitting, `$( )` substitution, flag guards for `find`/`git`/`sed`). A single write redirection revokes read-only status. **In `auto` the read-only fast path is retired**: the analysis now only guards `plan` (hard block) and feeds the "static structure" display line of `auto` dialogs — display, not verdict. Every rule-unmatched shell call, `ls` included, goes through the classifier; pin a command back to 0 s with an `allow` rule.

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
- decision + human-readable risk reason appear in the dialog (or become a headless denial).

### 4.2 Configuring `classifierModel`

`~/.pi/agent/approval-config.json`:

```json
{
  "classifierModel": "<provider>/<model>",
  "classifierStage1Model": "<provider>/<cheap-model>",
  "classifierStage2Model": "<provider>/<smart-model>",
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
- **Inspect or configure classifier models at runtime**: **`/classifier-model`**
  - **View status**: Run `/classifier-model` with no arguments to inspect the configured value, effective model, and fallback reason for both Stage 1 (screening) and Stage 2 (review).
  - **Set per-stage models**: `/classifier-model --stage1 <provider/model>` or `/classifier-model --stage2 <provider/model>` (both stages can be specified in one command, e.g. `/classifier-model --stage1 deepseek/deepseek-flash --stage2 deepseek/deepseek-v4-pro`, order-independent).
  - **Set both stages together**: `/classifier-model --both <provider/model>` (writes to shared key and clears stage-specific keys).
  - **Clear configurations**: `/classifier-model clear` (resets all stages back to builtin defaults and main model); targeted resets are also supported: `/classifier-model clear --stage1` (or `--stage2` / `--both`).
  - **Help and completions**: `/classifier-model help` shows syntax and examples. Full-cycle Tab completion is supported with mutual-exclusion pruning, metadata display (pricing, reasoning capability, context window), and active model indicators (`✓`).
  - **Migration notes**: Positional syntax `/classifier-model <model>` and `/classifier-model default` has been removed. Please migrate to `--both <model>` and `clear` respectively.
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

### 5.7 Is status-bar `(auto)` the same as `[⚖️ auto]`?

No — different semantics, different location, different owner:

| Display | Meaning | Controlled by |
| :--- | :--- | :--- |
| Line 2, `0.0%/262k (auto)` | **Pi native** auto-compaction indicator: shown when the context is auto-compacted as it nears the window limit | `compaction.enabled` in `settings.json` (built into Pi) |
| Extension status line, `[⚖️ auto]` | **This plugin's** approval-mode badge: ⚖️ (scale) stands for the two-stage LLM classifier auto-adjudicating allow/block | `/approval-mode` command, `Ctrl+Alt+A`, `--approval-mode` flag |

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

