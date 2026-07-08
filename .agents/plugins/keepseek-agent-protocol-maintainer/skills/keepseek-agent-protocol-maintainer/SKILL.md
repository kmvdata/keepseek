---
name: keepseek-agent-protocol-maintainer
description: KeepSeek AgentRunner and protocol maintenance workflow. Use when Codex works on DeepSeek/OpenAI-compatible request messages, streaming parsing, DSML fallback parsing, tool schemas, workspace tool routing, context compression, history projection, context usage estimation, or model run limits.
---

# KeepSeek Agent Protocol Maintainer

## Overview

Use this skill for any change where the model input, tool loop, streaming output, summary projection, or workspace tool boundary could drift from KeepSeek's protocol contracts.

## Map The Surface

- `src/agent/runner.ts`: orchestration, run limits, tool loop, final response assembly.
- `src/agent/protocol.ts`: system prompt, model messages, tool schema, token estimate entry points.
- `src/agent/historyProjection.ts`: model-facing projection, protected messages, recent turns, summary message.
- `src/agent/historyCompressor.ts`: best-effort summary refresh with short timeout and no user-visible failure.
- `src/agent/contextUsage.ts`: UI context estimate; must use the same projection semantics as real requests.
- `src/agent/deepseek/*`: compatible protocol types, SSE parser, DSML fallback parser.
- `src/agent/tools/workspaceTools.ts`: read-only workspace tool boundary and path resolution.
- `src/shared/config.ts` and `src/shared/types.ts`: normalized settings and shared contracts.

## Change Workflow

1. Read the caller and callee for the changed protocol path before editing.
2. Keep `AgentRunner` as orchestration; move pure parsing, projection, config, or workspace logic to the existing owner module.
3. When changing a tool:
   - Update the schema in `protocol.ts`.
   - Update routing in `runner.ts`.
   - Keep implementation in a tool/service module.
   - Return JSON `{ ok, error }` on tool failure instead of throwing raw exceptions to the model.
4. When changing compression or projection:
   - Preserve the invariant that UI messages are not synthetic summary messages.
   - Keep protected messages available as raw content when outside the recent window.
   - Update `contextUsage.ts` with the same projection semantics.
5. When changing streaming:
   - Keep SSE parsing in `DeepSeekStreamParser`.
   - Preserve `content`, `reasoning_content`, and streaming tool-call support.
   - Keep DSML parsing as a fallback, not the primary protocol.

## Safety Rules

- Agent tools may list and read workspace text files but must not write files directly.
- The only write-producing tool is `keepseek_create_draft_edit`; it creates pending DraftEdits.
- Summary refresh failure must not block normal user requests.
- Tool budgets come from `keepseek.maxToolIterations`, `keepseek.maxToolCalls`, `keepseek.maxRunMs`, and `keepseek.toolResultTokenBudget`.
- New config values must be declared in `package.json` and normalized in `shared/config.ts`.

## Verification

Run `npm run compile`. For projection or compression changes, also reason through: compression disabled fallback, no-summary fallback, summary failure fallback, protected messages, recent turns, and UI context window estimation.
