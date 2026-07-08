---
name: keepseek-regression-auditor
description: KeepSeek regression audit workflow. Use when Codex is asked to review, audit, pre-merge check, QA, or risk-assess KeepSeek changes, especially changes spanning provider orchestration, AgentRunner, context compression, references, Webview UI, DraftEdit application, configuration, or user-visible behavior.
---

# KeepSeek Regression Auditor

## Overview

Use this skill in code-review stance: lead with concrete bugs and regression risks, then summarize only after findings. Prefer file and line references over broad impressions.

## Audit Workflow

1. Inspect `git status --short` and avoid attributing unrelated existing user changes to the current work.
2. Read the diff and the nearest owner modules, not just the modified hunks.
3. Classify risk by affected surface:
   - Agent request/projection/tool loop.
   - Context reference serialization/expansion/opening.
   - Webview input/transcript/settings state.
   - DraftEdit write safety.
   - Session persistence and history trimming/compression.
   - Shared config/types/i18n.
4. Look first for behavioral regressions, missing migration compatibility, dropped fallback paths, broken message contracts, unsafe writes, and missing validation.
5. Run or request the relevant checks. Default to `npm run compile`; add `npm run lint` when lint-relevant files changed.

## High-Risk Checklists

For context compression, verify disabled fallback, no-summary fallback, summary failure fallback, protected messages, recent turns, and `contextUsage.ts`.

For references, verify full file, line range, column range, directory, external authorization, binary/large skip, serialization, expansion, and opener behavior.

For Webview input, verify send, edit/resend, drag-drop, `@` completion, chip deletion, clipboard fallback, and shared rich-text shortcuts.

For Agent tools, verify read-only boundaries, path traversal rejection, binary/size rejection, JSON error results, and DraftEdit-only writes.

## Findings Format

When issues exist, output:

- Findings first, ordered by severity, with clickable file links and line numbers.
- Open questions or assumptions.
- Short change summary only after findings.
- Tests run and tests not run.

If no issues are found, say that clearly and name residual manual test gaps.
