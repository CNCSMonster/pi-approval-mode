# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
