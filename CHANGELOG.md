# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
