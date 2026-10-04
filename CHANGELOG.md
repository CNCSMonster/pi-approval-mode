# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-10-04

### ✨ Features
- **Per-stage `/classifier-model` command with full-cycle autocompletion**:
  - Command flags support `--stage1 <model>`, `--stage2 <model>` (individual or combined, order-independent), and `--both <model>` (sets shared key, clears stage-specific keys).
  - Target-specific reset support: `clear` / `clear --both` resets all three keys, while `clear --stage1` / `clear --stage2` clears only the specified stage key.
  - Strict atomic validation (D1): all model references are validated against registered models and configured authentication before save; any invalid entry rejects the entire command without touching disk config (all-or-nothing).
  - Full-cycle Tab completion state machine: dynamic mutual-exclusion pruning, metadata display (`$in/$out per M`, `reasoning`, `ctx`), and active-model indicator (`✓`).
  - Command status view includes usage reminder line (D4), and `help` subcommand displays syntax and examples.
  - **Breaking / Migration**: Removed old positional syntax (`/classifier-model <model>` and `/classifier-model default`). Migrate to `--both <model>` and `clear` respectively.
- **Upstream content filter attribution & degraded-circuit self-healing**:
  - When classifier API requests are rejected by upstream moderation filters (`finish_reason=content_filter` / safety block), error attribution displays a dedicated upstream filter notice instead of misleading JSON parse failures.
  - Aligned with Qwen Code's `recordFallbackApprove` semantics, when the degraded circuit breaker is tripped and a human explicitly approves the action via the fallback dialog, the circuit recovers and resumes normal classifier operations (A' self-healing).

### 🛡️ Security & Trust
- **`auto` bash review-exemption retired; built-in destructive-git soft rule removed**: (1) the `destructive_git_operations` entry is deleted from `SECURITY_POLICY_RULES` — force-push / history rewriting is left to the classifier's common sense, and users who want a hard block write a `deny` rule themselves (`Bash(git push *--force*)`); every other policy entry is untouched, and the heuristic fallback patterns (`HIGH_RISK_PATTERNS`) are unchanged. (2) The Layer 2 read-only fast path no longer auto-allows in `auto` — every rule-unmatched bash call, interactive and headless alike, goes through the two-stage classifier; `analyzeShellCommand` is still called, solely to feed the dialog's "static structure" display line (display ≠ verdict). Scope held: `plan` keeps the analyzer as its only guard, Layer 1 workspace-edit exemption, the tool-default read layer and the `allow`-rule step-0 fast path are untouched. (3) Degraded-state (unavailable circuit tripped) bash keeps the existing `fallbackHeuristicCheck` matrix (dangerous → dialog/block, benign → allow). Alongside, two `plan`-guard holes are hardened: compiler binaries (`gcc`, `g++`, `clang`, `rustc` — no output/sub-command check, they write `a.out`) leave `SAFE_READ_ONLY_BINARIES` and `awk` leaves `SAFE_PIPE_FILTERS` (`system()` escape; the rule layer already treats awk as a dangerous interpreter). Known cost, stated honestly: in `auto`, `ls` / `git status` now pay a classifier round-trip instead of 0.0 s — add `allow` rules to pin them back. Covered by 11 new tests (123 → 134), with the mixed-traffic e2e flipped from "read-only fast-path allow" to "read-only bash enters the classifier"; all new assertions verified red against pre-fix `HEAD`.
- **Independent, validated Stage 1 / Stage 2 classifier timeouts**: `classifierTimeoutMs` is now documented as the Stage 1 fast-screen timeout and a new `classifierStage2TimeoutMs` controls the Stage 2 deep-review timeout (default = effective Stage 1 × 2, preserving the old `×2` semantics so the existing `stage2_timeout(3000ms)` assertion stays green). Load-time validation replaces the previous lone `> 0` check — which let `Infinity` (JSON `1e999`), values above 2³¹−1 (setTimeout overflow → immediate timeout), and sub-millisecond fractions slip through silently — with a single rule: any violation warns (`console.warn` + one `ctx.ui.notify`) and resets both fields to the 1500/3000 defaults. Each effective value must be an integer (`Number.isFinite` && `Number.isInteger`, so `NaN`/`Infinity`/`0.5`/`"5000"` are rejected), ≥ 500, Stage 1 ≤ 60000, Stage 2 ≤ 600000, and an explicitly set Stage 2 must exceed Stage 1; a missing field is not a violation (Stage 2 derives). The effective pair is logged via `console.debug` after load. `withTimeout`, stage ordering, and `recordUnavailable` accounting are untouched. Covered by 6 new tests (117 → 123), verified red against pre-fix `HEAD`.
- **Protected-path degrade slot filled: unavailable-circuit fuse now goes straight to human approval**: the interactive protected edit/write branch had no consumption for a tripped classifier-unavailable circuit — after fusing (u≥3, read directly via `unavailableCircuitTripped()`, never via `fallback.kind`, so a simultaneous denial rise cannot preempt it) every call still awaited the dead classifier through the stage-2 timeout before finally showing the human dialog. The sequence is now ① denial-cap deny → ② unavailable fuse → skip the classifier entirely and present a deny-by-default human-approval dialog ("受保护路径熔断人工核准", with the loop-warning row when a loop is detected) → ③ fingerprint short-circuit → ④ classifier. Protection level is unchanged (no heuristic degrade, read/bash degrade branches untouched); the headless path and `checkFallback` kind ordering are untouched, and ① keeps winning over ② when the session denial cap is reached with u≥3. Covered by 7 new e2e tests (110 → 117): zero classifier calls after the fuse with deny/allow outcomes, u<3 and fingerprint regressions, cap priority, headless `consecutive_unavailable` regression, and the loop-warning dialog.
- **Circuit-breaker statistics residuals closed**: (A) `recordAllow()` no longer clears the classifier-unavailable counter — fast-path allows (in-workspace edits, read-only shell, allow rules) never touched the classifier and had no right to heal outage stats; `consecutiveUnavailable` is now reset only by `recordClassifierActive()` and `resetAll()`, making the unavailable circuit reachable under mixed traffic. (C) the interactive side now consumes every fallback kind by priority: `total_denial` caps deny immediately (no classifier call, no dialog, with an allow-rule unblock hint), `classifier_blocked_retry` fingerprint hits skip re-classification and present a deny-by-default human dialog (baseline M10), and the unavailable-circuit heuristic degrade is preserved ahead of the fingerprint branch; `consecutive_block` remains unconsumed interactively (non-goal). (D) `switchMode()` resets the denial tracker alongside the loop detector, so switching out of `plan` no longer carries stale denial debt into `auto`; the wide denial counting scope (user denies / deny rules / plan blocks / self-tripped fuses all count as denials) is documented at `blockCall` and unchanged.
- **Stashed dangerous allow rules no longer revive on reload**: while auto-stash is active, every rule-loading path (`/approval-rules`, `/reload`, project-trust changes → `reloadAll()`) re-strips dangerous `allow` rules that come back from disk and merges them into the existing stash with `(scope, rule)` deduplication. Previously `persistRules` intentionally kept stashed rules on disk (disk = working pool + stash), and `reloadAll()` reloaded the whole table without re-stripping, so a stashed rule such as `Bash(npx *)` returned to the working pool and took part in `evaluate()` — silently bypassing the classifier while the UI kept reporting "⏸️ stashed". Restoring on auto exit is unchanged.

### 🔄 Loop Detection & UX
- **Approval dialog adaptive viewport line-wrapping**: long shell commands, labels, and option descriptions now wrap adaptively to the viewport width via pi-tui `wrapTextWithAnsi` with continuation-line indent alignment instead of being truncated with ellipses (`truncateToWidth`); long commands without whitespace word boundaries wrap character-by-character with zero content loss; narrow terminals (down to 40 columns) verified without overflow.
- **Auto status badge updated from 🤖 to ⚖️**: disambiguates our autonomous approval classifier from Pi's native auto-retry indicator, clarifying user-guide terminology.
- **Headless stop semantics tell the truth**: the 0002/0004-aligned "3 consecutive denials → loud headless stop" stays as session-level abort, but the wording no longer contradicts reality — headless loop interceptions now return a dedicated `headlessCircuitFused` circuit-breaker reason (session fused, human intervention required, retrying only inflates the count) instead of reusing interactive warnings that advise "switch strategy" or dialog options that don't exist headless; the `total_denial` text drops the false "unrelated safe work may continue" promise in favor of human-unblock guidance (allow rule / restart). The `consecutive_block` branch's headless unreachability (loop check at step -1 wins with the same event source and threshold) is documented at the tracker and pinned by an e2e test.
- **User denials made in outage dialogs count again**: the outage exemption now applies only to headless *automatic* classifier-failure blocks; a human's deny in the human-review dialog always records into the denial side (`consecutiveBlock`/`totalBlock`/loop consecutive-denials/fingerprint). The interactive unavailable-degrade branch now reads the unavailable counter directly, so the interactive "3 consecutive outages → heuristic" matrix cannot be preempted by the denial circuit once user denials count again.
- **Stagnation hard limit follows `hardLimitMultiplier`; dead branch documented**: the `action_stagnation` branch had a hard-coded `stagnationThreshold * 2` ceiling while every other branch uses `hardLimitMultiplier` (default 3), so tuning the multiplier left stagnation behind; it now uses the same multiplier (default 6 → hard limit 18 rather than 12). Check order is unchanged (qwen-aligned semantics), which keeps the branch unreachable under default 3/3/6 — the stagnation counter grows in lockstep with the identical-call counter, so check 1 or check 2 always trips first. The full reachability precondition (`identicalThreshold > stagnationThreshold` **and** `denialThreshold > stagnationThreshold`) is now documented in the module header and at the check site, and pinned by tests: one driving the branch under an explicitly reachable configuration (trigger, escalating warnings, new-multiplier hard limit) and one guarding the default-config semantics (consecutive denials / identical calls win; stagnation never fires).

### 🧪 Testing
- 109 → 164 tests: added comprehensive coverage for `/classifier-model` parsing/completion/D1 atomic-validation, dialog line wrapping, content-filter attribution, and auto bash review-exemption removal. All new tests verified red against pre-fix sources.

### 📖 Documentation
- Updated bilingual user guide and README with per-stage classifier command syntax and migration guide; documented loop-detector/tracker lockstep ordering facts, total-denial cap semantics, and denial-vs-unavailable counting scope.
- Loop-detector/tracker lockstep ordering facts, total-denial cap semantics and the denial-vs-unavailable counting scope are documented at the code sites.

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
