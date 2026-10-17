# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.15.0] - 2026-10-18

### ✨ Features & UX Improvements
- **Workspace Environment Profile**: tool-call reviews now include a workspace profile (project type, upstream git host, routine local ports) so the classifier judges local lifecycle commands against real environment facts; the profile is advisory context only and never grants authorization. A new `/approval-mode-setup` command inspects, overrides, and clears profile fields with trust gating and strict per-field validation.

### 🐛 Bug Fixes & Security Hardening
- **Protected-Path Realpath Matching & Sandbox Network Isolation**: symlinked paths resolve to real paths before protected-path matching, closing symlink-traversal bypasses; the read-only sandbox now blocks network side effects in addition to file writes.
- **Classifier Base Prompt Purification**: the classifier base prompt is rewritten to a neutral allow/deny contract with directional bias phrases removed, and conservative outage blocks no longer claim a heuristic evaluation occurred.

### 📚 Documentation
- **Classifier Best Practices & User Guides**: the best-practices guide records Stage 1 candidate re-evaluation, threshold-scan and two-stage combo-replay conclusions; user guides (English & Chinese) cover the workspace profile, `/approval-mode-setup`, sandbox network isolation, and symlink realpath semantics.

## [0.14.0] - 2026-10-15

### ✨ Features & UX Improvements
- **Business Scenario Data Capture (opt-in, OFF by default)**:
  - **Two-Phase Capture Engine**: tool-call intake (event A) and the final verdict (event B) are recorded as paired local records for offline evaluation and classifier tuning, with CAS-atomic writes, a quota budget, and orphan reconciliation (process-liveness plus a 24-hour dual threshold).
  - **Privacy by Default**: capture is strictly opt-in — enable it explicitly via `captureDataset.enabled` in the global config or the `PI_APPROVAL_MODE_CAPTURE=1` environment flag. Project configuration can only tighten (never enable), untrusted workspaces are always excluded, and all captured data stays on the local machine (cloud-sync risk boundary documented).
  - **Dataset Management Tools**: delete/export tools for captured datasets plus a dataset CLI script, with an injectable path resolver powering snapshot-driven replay scenarios.
- **Approval Rule Tier Attribution**: rule decisions now report which tier the matched rule came from (`user` / `project` / `session`), making it clear why a call was allowed, asked, or denied.

### 🐛 Bug Fixes & Security Hardening
- **Approval Dialog Fact Payload Visibility** (safety-critical human review):
  - Fact payloads are now always displayed for every pending call: edit matched/replaced text pairs, write full content, shell full command, and full external-tool arguments. AI transcriptions (summaries / risk assessments) are auxiliary and never replace the payload; oversized payloads show head/tail samples with the omitted amount explicitly stated.
  - Hero detail selection uses an explicit primary marking instead of the longest-item heuristic, and fact payloads rank above AI transcriptions in metadata ordering — short commands can no longer be crowded off the first screen by long AI prose.
  - Viewport height math reworked (header/footer-first allocation with content-slot budgeting and a final clamp): total dialog height never exceeds the target at any terminal height, verified across H=10/12/15/24/40 including ultra-short terminals.
  - The full detail panel (`m`) is reachable in any state — including folded and sub-16-row locked-compact terminals — guaranteeing no payload line is ever permanently invisible; the panel is a browsing state where `Esc`/`q` only exits the panel and number keys never submit directly.
  - Jump-to-bottom (`End`/`G`) always lands on the true last page; tiny viewports can no longer let hint lines crowd out the only content line.
- **Reusable Secret Scrub Pipeline**: secret scrubbing consolidated into a deterministic, reusable pipeline with matched-rule attribution, strengthening defense-in-depth for displayed and recorded tool arguments.

## [0.13.0] - 2026-10-15

### ✨ Features & UX Improvements
- **Approval Dialog Viewport Budget Governance & Key Decoupling**:
  - **Two-Pass Slot Allocation**: Chrome scaling and detail capacity are computed by a dependency-free two-pass algorithm so detail capacity is monotonically non-decreasing with terminal height — last-page content is always fully visible with no false bottoming-out.
  - **Sub-16-Row Hard Lock**: Terminals shorter than 16 rows rigidly lock the compact layout (expansion disabled) so dialog content can never scroll out of the viewport.
  - **Independent Scroll Routing**: In collapsed view `PgUp` / `PgDn` scroll the background conversation transcript; in expanded view they page through tool-call payload text in place (`↑`/`↓`/`k`/`j` fine-tune, `Space`/`b` page, `Home`/`End`/`g`/`G` jump), with the approval-option cursor fully pinned during scrolling.
  - **Esc / q Escape Hatch**: In expanded view `Esc` / `q` only collapses back to the folded state — it can never accidentally trigger a security rejection.
  - **Focus-Only Option Selection**: `Tab` / `Shift+Tab` cycle option focus and number keys `1`–`5` only move focus with a hint — submission requires an explicit `Enter`, eliminating accidental persistent-allow misfires.
  - **Scroll Memory & Diagnostic Panel**: Scroll offset persists across collapse/expand; `m` toggles a full metadata diagnostic view (loop warnings, block reasons, triage suggestions, static structure features).
  - **Stage 2 Summary Semantic Layering**: Risk-reason summaries and tool-call payload now scroll exclusively, preventing interleaved content jumps.
- **Classifier Markdown Contract & Natural Reasoning Flow**:
  - Robust Markdown decision contract with tail-anchored parsing and standalone-line decision support, tolerant to surrounding prose.
  - Natural reasoning flow with bidirectional context-field extraction for more faithful intent capture.
- **Structured Input Projection & Evidence Provenance**:
  - Write/edit payloads receive 4,000-character full exposure with head/tail sampling for oversized content.
  - Deterministic real-path resolution distinguishes new files, dangling symlinks, and resolution errors; dangling symlinks and workspace-escaping paths are blocked in a deterministic pre-layer.
  - **Evidence Provenance Hierarchy**: Only direct user input in the session and `AGENTS.md` from trusted projects count as authorization; in-band privilege forgery (e.g. `[ADMIN OVERRIDE]`, `ignore previous rules`) is classified as malicious injection and hard-blocked, while benign technical statements remain unaffected.
- **Project Trust Gate Extended to Approval Policies**:
  - Project-level `.pi/approval-policy.md` is now enforced behind the trust gate alongside configuration and rules files, blocking natural-language policy poisoning from untrusted repositories.
  - Repositories shipping only approval configuration files proactively prompt a trust dialog in interactive mode and fail closed with minimal privilege in headless/RPC environments.
- **Stage 1 Decision Primitive Upgrade**:
  - Stage 1 now speaks an explicit ALLOW/DENY decision primitive with biased instructional wording removed.
  - High-recall boundary tuning targets zero false-negative leaks, with enriched representative exemplars for environment and secret-handling scenarios.

### 🛡️ Security Hardening
- **Multi-Layer Shell & Sandbox Hardening**:
  - Unquoted newline (`\n` / CRLF) is treated as a command separator across all defense layers — multi-line commands are governed exactly like `&&` / `;` chains in rule matching and heuristics.
  - Heuristic fallback now detects interpreter payloads, `xargs` targets, and git flag bypass attempts.
  - Read-only sandbox hardening covers command substitution, workspace-boundary escapes, and tool-call identifier isolation.

### 📚 Documentation
- **User Guide Synchronization**: English and Chinese user manuals updated for dialog key decoupling, evidence provenance semantics, trust-gate coverage of policy files, and multiline compound-command matching.

## [0.12.1] - 2026-10-14

### 🐛 Bug Fixes & TUI Stability
- **Eliminate Bare Console Writes in Configuration Loaders**:
  - Replaced remaining `console.debug`, `console.warn`, and `console.error` calls across `applyClassifierThinkingConfig`, `applyClassifierTimeoutConfig`, policy loader truncation alerts, and permission engine persistence with safe file logger (`logClassifier*`).
  - Completely prevents unbuffered ANSI writes to standard output, eliminating cursor coordinate desynchronization and input line freeze when executing `/classifier-model`.
  - Added repository-wide static test assertions to ensure zero bare `console.*` writes in runtime modules.

## [0.12.0] - 2026-10-13

### ✨ Features & TUI Improvements
- **Approval Dialog In-Place Pagination & Viewport Height Protection**:
  - **In-Place Detail Pagination**: In expanded view (`v` / `Ctrl+O`), tool calls with long commands or script contents can be scrolled in-place using `PgUp` / `PgDn`, with dynamic slice indicators showing remaining lines above and below.
  - **Tri-State Intent Decoupling**: In collapsed view (default), `PgUp` / `PgDn` seamlessly passthrough to scroll the background conversation transcript; in expanded view, `PgUp` / `PgDn` navigate details in-place without adding new keybindings.
  - **Dynamic Viewport Chrome Protection**: Automatically reserves terminal rows for dialog chrome (headers, options 1-5, and shortcuts), dynamically sizing detail capacity so approval actions are never pushed off-screen.
  - **Slot-Aware Slice Calculation**: Deducts top/bottom indicator rows from detail slices to eliminate viewport overflow and terminal jitter.

### 📚 Documentation & Best Practices
- **Stage 2 Classifier Recommendation**: Updated recommended model for Stage 2 to `anthropic/claude-haiku-5.5` across best practice guidelines and user documentation.
- **User Guide Synchronization**: Updated English and Chinese user manuals to document folding, in-place paging, and transcript scrolling behaviors.

## [0.11.0] - 2026-10-12

### ✨ Features
- **Hierarchical Natural Language Approval Policies**:
  - **Dual-Tier Composition & Coexistence**: Replaces destructive workspace overriding with segmented inheritance. Both global personal security preferences (`~/.pi/agent/approval-policy.md`) and project workspace policies (`.pi/approval-policy.md`) load concurrently and coexist in dedicated sections within the classifier prompt.
  - **Independent Truncation Budgets**: Grants dedicated, independent 2,500-character budgets to global and project policies, providing explicit UI notifications when either policy exceeds its limits.
  - **Trust Gate Anti-Hijacking Isolation**: In untrusted workspaces (`isTrusted === false`), project policies are hard blocked while the user's global preferences remain strictly enforced, preventing prompt injection privilege escalation from untrusted third-party repositories.
  - **Immutable Three-Tier Precedence Hierarchy**: Embeds clear arbitration rules (`Default HARD BLOCK > Global User Security Preferences > Project Workspace Context & Policies`) into system prompt decision principles, strictly preventing project policies from relaxing global user boundaries and erring on the side of blocking during ambiguity.
  - **User Manual & Guide Synchronization**: Documented natural language approval policy usage and inheritance semantics in user guides.

## [0.10.0] - 2026-10-11

### 🛡️ Security & Robustness Hardening
- **Multi-Vector Approval Security Hardening**:
  - **Cross-Platform Shell Governance**: Expands tool interceptor to unify PowerShell (`powershell`, `pwsh`) with bash under the primary approval matrix and strict read-only analyzer.
  - **Compound Command Injection Defense**: Enhanced AST and tokenizer patterns neutralize operator chaining (`&&`, `||`, `;`) and command substitution (`$(...)`, `` `...` ``) allowlist bypasses.
  - **Tier 1 Sandbox Priority in Read-Only Mode**: Prioritizes OS-level sandboxing (Bubblewrap / Seatbelt) before static fallback rules, safely wrapping exploratory commands (e.g. `python test.py`) without premature allowlist rejections.
  - **External Unrecognized Tool Physical Blocking**: Automatically blocks unconfigured external MCP tools with `EBUSY`/`EPERM` in non-interactive/headless environments and read-only mode to prevent side effects.
  - **State Machine Concurrency Lock**: Serializes concurrent rule mutations in `PermissionManager` to eliminate race conditions and avoid reviving temporary allow rules.

### 🐛 Bug Fixes & Diagnostics
- **Classifier Upstream 402 Balance & TUI Console Render Integrity**:
  - **Non-Intrusive Safe File Logging**: Replaces bare `console.error` and `console.warn` writes on hot classification paths with structured file logging (`~/.pi/agent/logs/approval-mode.log`), preventing ANSI hardware line-breaks from desynchronizing `pi-tui` cursor coordinates and covering the user input box.
  - **Dedicated 402 Insufficient Balance Recognition**: Adds `insufficient_balance` (`upstream_402(Insufficient Balance)`) error classification in `upstream-error-extractor.ts`, providing targeted guidance for account top-up and model switching.
  - **UI Notification & Modal Hints**: Surfaces proactive UI notifications and approval modal diagnostics (`🔧 排障建议`) for upstream quota exhaustion and balance depletion.


### ✨ Features
- **Lightweight Read-Only Exploration Mode & OS Kernel Sandboxing**:
  - **Tool Schema Invariant**: Keeps tool declarations (including `edit`, `write`, `bash`) 100% intact throughout session lifecycles, eliminating Gemini 400 runtime crashes (`undeclared_tool_name`) and preventing prompt cache (KV cache) invalidation.
  - **Two-Tier Layered Execution Sandbox**:
    - **Tier 1 (Kernel Sandbox)**: Enforces write restrictions at the OS kernel level using `sandbox-exec` (Seatbelt) on macOS and Bubblewrap (`bwrap`) on Linux, shielding against arbitrary script execution and escaping.
    - **Tier 2 (Strict Allowlist Fallback)**: Automatically falls back on Windows or environments lacking bubblewrap to a strict read-only command allowlist, intercepting redirection (`>`, `>>`) and unsafe mutations in 0ms.
  - **Objective Physical Error Feedback & Zero Disruption**: Intercepts `edit` and `write` tool calls with standard `EROFS: read-only file system` errors without human approval dialogs, guiding models to self-correct and formulate plans directly in text response.
  - **Context-Preserving Prompt Injection**: Injects read-only `<system-reminder>` directives non-intrusively via `context` hooks to the trailing user message and adds system guidelines without polluting conversation history.
  - **Mode Aliasing & Shortcuts**: Introduces `/readonly` command with `/plan` alias compatibility, accessible via standard shortcut `Ctrl+Alt+P`.
- **Classifier Upstream Error Diagnostics & UI Observability**:
  - **Structured Diagnostic Extraction**: Extracts precise HTTP error codes and categorization from upstream classifier failures, preventing silent swallowed generic exceptions.
  - **Proactive Anomaly Categorization**: Accurately classifies provider region lockouts (`upstream_403(Region Blocked)`), authentication failures (`upstream_401(Auth Failed)`), rate limits (`upstream_429(Rate Limited)`), and network proxy dropouts.
  - **Approval Dialog & UI Alert Propagation**: Surfaces diagnostic hints directly in interactive approval dialogs (`🔧 排障建议`) and raises UI error notifications on critical 403/401 events to guide users on network proxy or API credential fixes.
- **Workspace Project-Specific Natural Language Approval Policy**:
  - **Custom Policy Loading**: Supports loading workspace-specific approval guidelines from `.pi/approval-policy.md` (or global `~/.pi/agent/approval-policy.md`), seamlessly appending them to classifier evaluation prompts.
  - **Trust Gate Protection & Invariant Defense**: Strictly gates policy loading behind workspace trust (`isProjectTrusted()`), neutralizing malicious policy prompt injection in untrusted repositories.
  - **Prompt Budget & Safety Invariant**: Enforces a 3,000 character maximum budget limit with graceful truncation and preserves the core invariant that project policies can only expand review requirements and never weaken or bypass default hard blocks.
- **Documentation & User Guide Synchronization**:
  - Synchronized comprehensive bilingual user guides (`user-guide.zh-CN.md` and `user-guide.md`) detailing Read-Only mode mechanics, sandbox architecture, and upstream troubleshooting guides.

## [0.8.0] - 2026-10-08

### ✨ Features
- **Independent Per-Stage Classifier Thinking Configuration**:
  - **Granular Reasoning Controls**: Extends `/classifier-model` with the `--thinking <level>` argument, supporting 7 standardized thinking tiers (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) individually configurable for `--stage1`, `--stage2`, or `--both`.
  - **Fail-Safe Fallback & Capability Validation**: Validates thinking levels against target model registry capabilities (`model.reasoning`, `model.thinkingLevelMap`, and specialized classifier constraints). Incompatible or unsupported configurations automatically log explicit warnings and safely fall back to unconfigured provider defaults without interrupting approval flow.
  - **Intelligent Autocompletion**: Interactive Tab completion dynamically enumerates available thinking levels, prunes conflicting flags, and reflects active thinking settings in status views.
- **Claude Code Industrial Safety Rules Absorption**:
  - **Lease-Verified Force Push Exemption**: Granular git push heuristic pattern allows safe collaborative workflows using `git push --force-with-lease` while strictly intercepting unleased, destructive bare `git push --force` or `git push -f`.
  - **Modern Credential & Infrastructure Path Protection**: Broadens protected path coverage to include Python PyPI tokens (`.pypirc`), Git credential helpers (`.git-credentials`), GitHub CLI hosts (`.config/gh/hosts.yml`), GitLab CLI configurations (`.config/glab-cli/config.yml`), and cloud infrastructure / cluster definitions (`helm`, `iam`, `k8s`, `kubernetes`, `rbac`).
  - **Compact Reason Contract**: Enforces strict brevity constraints on classifier reasoning (`reason` under 15 words or 60 characters), reducing LLM generation tokens and latency across evaluation stages.
- **Safety Policy Prompt Enhancement Aligned with Codex Guardian**:
  - Re-architected base classification prompts (`CLASSIFIER_BASE_PROMPT`) incorporating deterministic positive and negative policy samples aligned with production-grade safety guardrails.
  - Distinguishes irreversible destruction from legitimate developer actions (e.g. routine build artifact cleanup, safe cache clearing, package management), minimizing false positive friction while maintaining zero tolerance on credential exfiltration and unauthorized network transfer.
- **Benchmark-Validated Production Topology**:
  - Establishes verified dual-stage configuration recommendation: Stage 1 `deepseek/deepseek-flash` (`low`) + Stage 2 `openrouter/anthropic/claude-haiku-5.5` (`low`).
  - Delivers P50 latency of 856ms with 95.0% clean benchmark accuracy and robust resilience against in-band prompt injection bypasses.


## [0.7.0] - 2026-10-06

### ✨ Features
- **Approval Dialog Viewport Height Budget & Long Detail Folding**:
  - **Dynamic Viewport Height Budget**: Limits approval dialog height so normal terminals preserve at least 55% of the viewport for conversation transcript. Short terminals (<= 28 rows) automatically trigger compact degradation to ensure all action options and footers remain visible without viewport clipping.
  - **Head-3 Tail-2 Detail Folding & Keybinding**: When an action command or detail exceeds 5 visual lines, it collapses into a compact fold displaying the first 3 lines, an omission count indicator, and the last 2 lines. Pressing `v`, `Ctrl+O`, or uppercase `V` toggles smooth in-place expansion and collapsing.
  - **Batch Tool Progress Indicator**: Dialog titles for multi-tool execution batches display context progress indicators (e.g. `[2/3]`) to help developers track sequential approvals.
- **Native Stage 1 Classifier Integration via Pi Classifier Registry**:
  - Integrates Stage 1 fast-screening with Pi's native classifier model catalog and `ctx.modelRegistry.classify()` API, standardizing context extraction and classifier telemetry without custom transport wrappers.
  - `/classifier-model --stage1 <model>` tab completion dynamically enumerates available specialized classifier models with dedicated `(classifier)` markers.
  - Seamlessly cascades safe verdicts to zero-overhead fast passes and escalates boundary cases to Stage 2 deep verification.
- **Classifier Configuration Conflict Governance & Role Defense**:
  - **Loud Ignore Principle**: When `classifierModel`, `classifierStage1Model`, and `classifierStage2Model` coexist, Stage 1 and Stage 2 dedicated models take precedence, safely ignoring the legacy global base model in memory without mutating disk configurations while issuing an explicit warning banner.
  - **Classifier Role Invariant Defense**: Specialized classifiers (such as Jev) are strictly prohibited from serving as global base models or Stage 2 deep reviewers, preventing invalid tool call execution without human-readable reasoning.
  - **Diagnostic Status Reporting**: `/classifier-model status` displays detailed resolution paths, active model designations per stage, and loud-ignore conflict diagnostics.

### 🧪 Improvements & Hardening
- **Test Suite Configuration Isolation & Anti-Drift Hardening**:
  - Test harnesses explicitly inject fully-typed micro-threshold presets (`MICRO_TEST_LIMITS`), decoupling state machine tests from production default limits.
  - Replaced legacy multi-iteration loops with deterministic boundary assertions, reducing test suite execution latency while retaining dedicated baseline anchor assertions.
  - Verified via bidirectional mutation testing (scaling defaults up to 100 and down to 10), guaranteeing resilience against future default quota adjustments.

### ✨ Features
- **Stage 1 Fast-Screen Persistent Status Bar Visibility & Escalating Alerts**:
  - When the Stage 1 fast-screen classifier degrades (due to timeout, connection issues, or upstream exceptions), the status bar badge seamlessly updates from `[⚖️ auto]` to `[⚖️ auto | S1⚠️]`, providing persistent user visibility without disrupting developer workflows.
  - Automatically heals back to `[⚖️ auto]` immediately upon any successful Stage 1 response.
  - Features a 5-consecutive-failure threshold alert: notifies the user with actionable instructions to inspect or switch models via `/classifier-model` if failures persist.
  - Invariant preserved: Stage 1 degradation never blocks agent tool calls, as all evaluations cleanly fall through to Stage 2 deep verification.
- **Dual-Channel Error & Rejection Messaging**:
  - User-facing channel: TUI status indicators, notifications, and prompts provide concise, human-friendly guidance without internal protocol jargon.
  - Agent-facing channel: Tool results return structured diagnostic contracts (`[Approval Policy: BLOCKED]`, `[Execution Loop: STAGNATION]`, `[User Decision: REJECTED]`, `[User Directive: ABORT_DIRECTION]`) containing explicit `Error`, `Constraint`, and `Next Steps` fields to empower model self-correction while strictly avoiding human-oriented UI instructions.
- **Stage 1 Independent Health Tracking**:
  - Stage 1 fast-screen timeouts and exceptions no longer contaminate the global `consecutiveUnavailable` circuit counter. Stage 2 deep review handles the evaluation, and an in-session notification deduplicates initial transitions.
- **Automated Code Quality & 80% Coverage Gate Tooling**:
  - Integrated `oxlint` with `--deny-warnings` for ultra-fast, zero-overhead static code analysis.
  - Added `scripts/check-coverage.js` as the default test harness, asserting that all 9 core modules meet or exceed an 80% threshold across line, branch, and function metrics, failing the build on any violation.

### 🛡️ Security & Trust
- **Approval Dialog Untrusted Argument Sanitization & Security Warning Banner**:
  - Replaces raw rendering of unvalidated command strings, paths, and details with visible, escape-resistant representations: C0/C1 control characters (`\x1b`, `\r`, `\t`, `\x7f`, etc.) are rendered as `[ESC U+001B]`, `[TAB U+0009]`, and `[CTRL U+000D CR]`, neutralizing terminal ANSI injection and cursor line-overwrite exploits.
  - Unicode Bidirectional override and isolation characters are safely escaped as `[BIDI U+XXXX <NAME>]` to thwart Right-to-Left (RLO) visual spoofing.
  - Renders a prominent warning banner above the dialog whenever sanitized control sequences are detected, alerting users to potential obfuscation attacks.
  - Critical invariant: Underlying tool execution receives raw, untampered parameters, confining all escaping strictly to the presentation layer.
- **Deterministic Heuristic Fallback Action Matrix**:
  - In classifier-degraded states, deterministic heuristic inspection classifies tool calls into safe actions (automatically allowed) versus high-risk destructive actions, sensitive file reads, or unknown tools (prompted for human review in interactive mode, safely blocked in headless mode).
- **Yolo Mode Loop Interception & Non-Termination Self-Correction**:
  - When loop detector identifies identical tool call loops in `yolo` mode, calls are intercepted immediately (at streak ≥ 3) rather than allowing execution up to streak 9.
  - Interceptions pass `terminate: false`, returning actionable error descriptions to let models adjust strategy rather than prematurely killing the agent process.
- **Denial Budget (Total Friction Cap) Lifecycle & Self-Healing**:
  - Increased default session denial cap from 20 to 50 to accommodate complex workflows.
  - Established 4 explicit budget recovery timings: (1) new conversational turns, (2) human approval on fallback dialogs, (3) consecutive success self-healing (every 3 successful actions decrements total block count by 3), and (4) session restarts/mode switches.
  - In interactive mode, reaching the cap triggers step-by-step human review without terminating the agent session.
- **Session Config Reset on Reload**:
  - During `/reload` and session initialization, configuration deletions are detected and in-memory properties/thresholds reset cleanly to baseline defaults.
  - Switching to untrusted projects strictly purges previous project-level settings to prevent security leaks.

### 🧪 Testing
- Expanded test suite from 164 to 198 tests with 100% pass rate.
- Attained 100% branch and line coverage on `classifier-projection.ts` and `denial-tracker.ts`, driving overall repository coverage to 90.42% Line, 88.95% Branch, and 94.78% Function.

### 📖 Documentation
- Updated bilingual user guide with Stage 1 health status bar indicator explanations (`[⚖️ auto | S1⚠️]`), troubleshooting procedures, and model configuration best practices.

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
- **Headless stop semantics tell the truth**: the "3 consecutive denials → loud headless stop" stays as session-level abort, but the wording no longer contradicts reality — headless loop interceptions now return a dedicated `headlessCircuitFused` circuit-breaker reason (session fused, human intervention required, retrying only inflates the count) instead of reusing interactive warnings that advise "switch strategy" or dialog options that don't exist headless; the `total_denial` text drops the false "unrelated safe work may continue" promise in favor of human-unblock guidance (allow rule / restart). The `consecutive_block` branch's headless unreachability (loop check at step -1 wins with the same event source and threshold) is documented at the tracker and pinned by an e2e test.
- **User denials made in outage dialogs count again**: the outage exemption now applies only to headless *automatic* classifier-failure blocks; a human's deny in the human-review dialog always records into the denial side (`consecutiveBlock`/`totalBlock`/loop consecutive-denials/fingerprint). The interactive unavailable-degrade branch now reads the unavailable counter directly, so the interactive "3 consecutive outages → heuristic" matrix cannot be preempted by the denial circuit once user denials count again.
- **Stagnation hard limit follows `hardLimitMultiplier`; dead branch documented**: the `action_stagnation` branch had a hard-coded `stagnationThreshold * 2` ceiling while every other branch uses `hardLimitMultiplier` (default 3), so tuning the multiplier left stagnation behind; it now uses the same multiplier (default 6 → hard limit 18 rather than 12). Check order is unchanged (qwen-aligned semantics), which keeps the branch unreachable under default 3/3/6 — the stagnation counter grows in lockstep with the identical-call counter, so check 1 or check 2 always trips first. The full reachability precondition (`identicalThreshold > stagnationThreshold` **and** `denialThreshold > stagnationThreshold`) is now documented in the module header and at the check site, and pinned by tests: one driving the branch under an explicitly reachable configuration (trigger, escalating warnings, new-multiplier hard limit) and one guarding the default-config semantics (consecutive denials / identical calls win; stagnation never fires).

### 🧪 Testing
- 109 → 164 tests: added comprehensive coverage for `/classifier-model` parsing/completion/D1 atomic-validation, dialog line wrapping, content-filter attribution, and auto bash review-exemption removal. All new tests verified red against pre-fix sources.

### 📖 Documentation
- Updated bilingual user guide and README with per-stage classifier command syntax and migration guide; documented loop-detector/tracker lockstep ordering facts, total-denial cap semantics, and denial-vs-unavailable counting scope.
- Loop-detector/tracker lockstep ordering facts, total-denial cap semantics and the denial-vs-unavailable counting scope are documented at the code sites (see entries above).

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
