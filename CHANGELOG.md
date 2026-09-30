# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-09-30

### ✨ Features
- **Per-stage classifier models**: new `classifierStage1Model` / `classifierStage2Model` config keys (fall back to shared `classifierModel`) so the fast screen and the deep review can use different models; `/classifier-model` prints per-stage configured → effective values with fallback reasons. Failure semantics: stage-1 failure falls through to stage 2; stage-2 failure fails closed (interactive → human-review dialog, headless → deny); if no model can be resolved at all, the call degrades to heuristic checks instead of hard-blocking.
- **Skill-directory read allowlist**: read tools targeting user-level skill dirs (`~/.pi/agent/skills/**`, `~/.agents/skills/**`) are always fast-pathed, project-level ones (`.pi/skills/**`, `.agents/skills/**`) when the project is trusted; explicit `deny`/`ask` rules still win, and symlink / `../` escapes never qualify (realpath-checked).
- **`auto-edit` path boundaries**: edits/writes to protected paths or outside the workspace now require confirmation in `auto-edit` (headless: blocked) instead of being auto-approved; regular in-workspace edits stay fast-pathed.
- **Bilingual docs split into separate files**: `README.zh-CN.md` and `docs/user-guide.zh-CN.md` are standalone files cross-linked with relative paths; in-file anchor switching is gone.
- **README `default` disambiguation**: notes where `default` is a rule verdict state (delegating to the mode funnel) versus the renamed `manual` mode, linking to the user-guide FAQ.
- **Positioning copy**: README taglines describe an independent design distilled from studying multiple code agents; Qwen Code DSL compatibility remains as a factual note.

### 🛡️ Security & Trust
- **Classifier-outage statistics separated from denial statistics**: blocks caused by classifier failures (stage-2 exception / timeout / JSON parse) count only toward the classifier-unavailable circuit and no longer inflate consecutive-denial or loop-detection counters, so the outage-degradation branch stays reachable; the classifier-unavailable default threshold is aligned to 3 (denial-circuit family value).

### ⚙️ Changed
- In-session classifier fallback notices are deduplicated per configuration key (no repeat spam after `/reload`).

### 🧪 Testing
- 78 → 90 tests: per-stage model resolution and failure semantics with interactive human-review and circuit-degradation cases; skill-dir allowlist unit + hook-level coverage (3 modes × interactive/headless); auto-edit boundary hook-level cases; default classifier-unavailable threshold anchor; test suites redirect `HOME` so they never touch the real user config.

### 📖 Documentation
- Bilingual split files (above); behavior-matrix updates (auto-edit boundary rows, skill-dir read exemption footnote); classifier per-stage config keys documented in README and user-guide (EN/ZH); fixed the historical guide→README dead link and the Chinese FAQ anchor target.

## [0.3.0] - 2026-09-30

### 💥 Breaking Changes
- **Renamed the `default` approval mode to `manual`**: CLI flag (`--approval-mode manual`), config (`defaultMode`), and `/approval-mode manual`. Old `default` values are accepted and mapped to `manual` transparently (config, CLI, session history); the rules' fourth-state verdict `default` is unchanged.

### ✨ Features
- **Sessions now start in `auto`** (classifier-driven) instead of the safe baseline; an explicit `defaultMode` still wins. The YOLO resume downgrade target is `auto`, or your configured `defaultMode`.
- **`auto` guardrail**: broad allow rules that would defeat the classifier (tool-level `Bash`, dangerous bash interpreters like `Bash(npx *)`) are temporarily stashed while in `auto` and restored on exit; adding such a rule while already in `auto` stashes it immediately (aligned with Qwen Code `stripDangerousRulesForAutoMode`). Stashed rules are visible in `/approval-rules`.
- Trust-gate regression coverage: an untrusted project's `defaultMode` (e.g. `"yolo"`) is blocked together with the whole project config file.

### ⚙️ Changed
- `loadApprovalConfig` extracted to the dependency-free `extensions/approval-config.ts` (pure module, injectable agent dir) so the config/trust-gate chain is unit-testable; `approval-mode.ts` re-exports the previous API.
- Status badges and dialog titles: `[🛡️ manual]`, `Manual Mode`.

### 🧪 Testing
- +9 tests (78 total): mode aliasing, trust-gate `defaultMode` attack regression, dangerous-allow predicate/strip/restore/stash/persistence.

## [0.2.1] - 2026-09-29

### 📖 Documentation
- Added the bilingual **User Guide** (`docs/user-guide.md`, English first / 中文随后): quickstart, approval-mode × tool behavior matrix, rules cookbook, classifier & model setup, FAQ & troubleshooting, development guide.
- README: English and Chinese sections brought to full parity (approval-modes table, config JSON samples, trust gate, shortcuts & commands, license in both languages); corrected the stale `/reload` session-rule semantics in the English section; added user-guide links.

## [0.2.0] - 2026-09-29

### 🛡️ Security & Trust
- **Classifier Transcript Alignment**: The two-stage safety classifier now receives a hardened transcript aligned with qwen-code's iron rules — assistant text/thinking stripped (prevents self-endorsement), tool results/bash executions stripped (prevents prompt-injection via untrusted content), prior tool calls rewritten as `Prior action: tool(projected args)`, last 40 message entries.
- **Minimal Tool Input Projection**: Replaced full-argument exposure with field-limited projections — `bash`→`{command,cwd}`, `edit`→path + first-5 edit previews (300 chars), `write`→path + byte count + 300-char content preview, read-family→path only.

### ⚙️ Permissions & Engine
- **Four-State Permission Rules**: Rule verdicts extended from `deny > ask > allow` to `deny > ask > default > allow`. Explicit `default` rules delegate to the approval-mode funnel (LLM classifier in `auto` — interactive fallback to manual, headless rejection; manual confirmation in `auto-edit`/`default`; allow in `yolo`/`plan`). Omitting `default` rules preserves legacy tri-state behavior (complexity pay-as-you-go). Cross-layer conflict detection, `/approval-rules` display, and JSON persistence now cover the fourth state.
- **Tool Default Permission Layer**: Read-family tools (`read`/`grep`/`find`/`ls`) without a matching rule fast-path only inside the workspace; out-of-workspace targets (including `~` expansion) require interactive confirmation in every mode — closing the read fast-path blind spot identified against qwen-code's `getDefaultPermission()`.
- **Round-Trip Safe Read Rules**: Approval dialogs now emit scope-correct `Read(...)` rules (`//` for absolute, `~/` for home, relative for workspace paths), and path matching expands `~` on the target side, so remembered decisions reliably match future calls.

### 🪄 Command Surface
- **Command Cleanup & Completion**: Removed the `/mode`, `/yolo`, and `/plan` shortcuts — mode switching is unified under the `Ctrl+Alt+A` quick key and the single `/approval-mode` command; `/approval-mode` now supports Tab argument completion listing all five modes with descriptions.

## [0.1.0] - 2026-09-29

### 🛡️ Security & Trust
- **Project Config Trust Gate**: Integrated Pi's native `ctx.isProjectTrusted()` to guard against policy poisoning. In untrusted repositories, project-local `.pi/approval-config.json` and `.pi/approval-rules.json` are strictly isolated, falling back safely to user global configuration and alerting the user.
- **Security Policy Single Source of Truth (SSOT)**: Unified deterministic heuristic fallback rules and LLM safety classifier prompts under `SECURITY_POLICY_RULES`. Built bidirectional automated drift-detection tests to guarantee semantic consistency across offline and online paths.
- **Heuristic False Positive Elimination**: Fixed false alarms on `> /dev/null` stream redirections and permitted `rm -r` directory cleanups on common build artifacts (`node_modules`, `dist`, `build`, `.cache`, etc.).

### ⚙️ Permissions & Engine
- **Cross-Layer Conflict Detection**: Added shadowed rule and duplicate conflict detection in `PermissionManager.addRule`, alerting users via TUI warnings when a newly added rule would be overridden by higher-severity directives.
- **Reload Lifecycle Contract**: Session-scoped permissions (`sessionRules`) are now preserved across `/reload`, ensuring ephemeral authorizations granted during an active session are not wiped by configuration reloads.

### 🔄 Loop Detection & UX
- **Stagnation Detection Thrashing Fix**: Refined loop detector to accurately differentiate genuine progress from parameter-thrashing stagnation, avoiding false positives on legitimate tool usage sequences.
- **TUI Alert Fatigue Governance**: Loop warnings now escalate progressively with iteration counts; added single-key shortcut option 6 (`Block & Abort`) to command the model to halt failing trajectories; added configurable hard-limit circuit breaker.

### 🤖 Headless Mode & Guidance Alignment
- **Denial State Machine & Fingerprint Short-Circuit**: Implemented `DenialTracker` with 3-tier limits (`consecutiveBlock`, `consecutiveUnavailable`, `totalDenials`) and `pendingManualRetryFingerprint` to prevent repeated classifier burns on identical blocked calls.
- **Standardized English Guidance**: Replaced Chinese UI-centric error messages in headless denials with standardized English guidance (`DENIAL_MESSAGES`), eliminating invalid slash-command prompts and giving actionable alternative guidance.

### 👁️ Observability
- **Hot-Reload for Model Registry**: Trigger `modelRegistry.refresh({ allowNetwork: false })` on `/reload` to immediately pick up newly defined models without restarting.
- **Explicit Fallback Warnings & Status Summary**: Emits clear UI warnings when configured classifier models are unauthenticated or missing, and displays an informative state summary banner after each reload.
