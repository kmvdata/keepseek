---
name: keepseek-architecture-guardian
description: KeepSeek architecture guardrail workflow. Use when Codex plans, implements, reviews, or refactors KeepSeek code and must preserve module boundaries across extension activation, provider orchestration, sessions, context references, agent protocol, DraftEdit writes, shared config/types, and webview string modules.
---

# KeepSeek Architecture Guardian

## Overview

Use this skill to keep KeepSeek changes aligned with the repository architecture in `AGENTS.md`. Treat current source and `AGENTS.md` as the source of truth; do not revive older conventions from memory.

## Workflow

1. Read `AGENTS.md`, `git status --short`, and the smallest relevant source files before planning edits.
2. Classify the change by owner:
   - Activation and commands: `src/extension.ts`.
   - VS Code/Webview coordination: `src/provider/KeepseekChatViewProvider.ts`.
   - Webview message input types: `src/provider/webviewMessages.ts`.
   - Business state: `src/sessions/*`, `src/context/*`, `src/edits/*`.
   - Agent protocol and model flow: `src/agent/*`.
   - Webview output strings: `src/webview/*`.
   - Shared contracts: `src/shared/*`.
3. Keep implementation in the owner module and wire it through Provider only when it crosses the Webview/extension boundary.
4. Update companion files for cross-cutting contracts before calling the change complete.
5. Preserve unrelated user edits, especially in files already modified before the task began.

## Boundaries

- Keep `extension.ts` limited to activation, command registration, Provider construction, and event wiring.
- Keep Provider as coordinator. Move independently testable logic into service modules or existing stores.
- Keep `AgentRunner` focused on request orchestration; do not put DraftEdit application or workspace write logic there.
- Keep AI writes as DraftEdit proposals. Actual disk writes belong behind user confirmation in `DraftEditStore` and `SafeFileEditor`.
- Keep workspace tools read-only except `keepseek_create_draft_edit`, which creates pending edits only.
- Keep webview files as string emitters and respect the split between transcript/settings/session code and input-specific code.
- Reuse `shared/config.ts`, `shared/types.ts`, `shared/errors.ts`, `shared/format.ts`, `shared/markdown.ts`, and `shared/textFileGuards.ts` instead of duplicating shared logic.

## Companion Checks

- New configuration: update `package.json` and `src/shared/config.ts`.
- New Webview to extension message: update `webviewMessages.ts`, Provider handling, and the Webview sender.
- New extension to Webview push message: update only Webview listeners, not `WebviewMessage`.
- Reference format changes: check `context/references/*`, `webview/input/script.ts`, and `webview/script.ts`.
- Context compression changes: check `shared/types.ts`, `historyProjection.ts`, `historyCompressor.ts`, `contextUsage.ts`, and `runner.ts`.
- DraftEdit behavior changes: keep write semantics in `edits/*`, not AgentRunner.

## Verification

Run `npm run compile` for normal code changes and `npm run lint` when the touched surface is lint-covered. For broad behavior changes, name the manual checks from `AGENTS.md` that still need Extension Development Host testing.
