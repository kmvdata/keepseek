# KeepSeek main model and subagents

KeepSeek protocol v5 adds isolated subagents without copying the parent chat into each child. New sessions freeze three orchestration tools:

- `keepseek_delegate_task`
- `keepseek_delegate_parallel`
- `keepseek_read_subagent_result`

Hot protocol v1-v4 sessions keep their existing system prompt and tool schema until the same cache-safe migration boundaries already used by KeepSeek (for example a model/source lane change, a cold provider prefix, or context compaction).

## Runtime boundary

`KeepseekChatViewProvider` remains the UI coordinator. Its main `AgentRunner` owns the parent run. `SubagentRuntime` schedules children, and every child gets a fresh `AgentLoop` plus fresh workspace, semantic, Git, authorization, draft, trace, and provider-run state. A child never reuses the mutable services of the parent or a sibling.

A child receives only:

1. a static child system prompt;
2. the selected built-in or Skill profile;
3. applicable project `AGENTS.md` instructions;
4. its self-contained task and explicitly authorized external references;
5. a lane-restricted, frozen tool schema.

It does not receive parent messages, parent reasoning, parent tool results, parent context files, session archive results, Legacy Project Memory, or unrelated Skills. Only the bounded child final result enters the parent tool result. Full child final text is stored locally and can be read in pages; hidden reasoning and the child tool trace are never returned by the result reader.

## Model selection

Account management contains one global subagent model selector. Its persisted file is:

`globalStorageUri/accounts/settings.v1.json`

The default is `follow-main`. A fixed selection stores both `sourceId` and `modelId`. If that exact source/model is later missing, disabled, incompatible, or lacks required credentials, delegation fails visibly and does not fall back to another account or model. Each child freezes the resolved source configuration at startup.

## Profiles and lanes

Built-in profiles are `research`, `review`, and `proposal`.

- Read profiles expose bounded workspace, semantic, diagnostic, and read-only Git tools.
- Proposal profiles may additionally prepare DraftEdits and DraftRuns. They cannot apply edits, approve commands, or execute arbitrary commands.
- Read profiles may delegate one more level when allowed. Proposal children and depth-2 children cannot delegate further.

A Skill can define a child-only profile:

```yaml
---
name: Security reviewer
description: Review one bounded security surface.
metadata:
  keepseek:
    runAs: subagent
    profile: security-review
    tools:
      - keepseek_search_workspace
      - keepseek_read_workspace_file_range
    maxSteps: 7
    timeoutMs: 45000
    canDelegate: false
    resultMaxChars: 64000
---
```

The parent sees only a compact profile catalog (capped at 4,000 characters). Full Skill instructions and referenced resources are injected only into the selected child.

## Limits and cancellation

Current hard defaults are:

- total child concurrency: 4;
- root-child concurrency: 3, reserving one slot for bounded nested work;
- proposal concurrency: 2;
- maximum depth: 2;
- maximum direct children per parent run: 8;
- maximum children per delegation tree: 12;
- default child tool steps: half the parent allowance, with a minimum request of 5 and the model profile still authoritative;
- default child duration: 5 minutes, hard-capped at 15 minutes;
- parallel batch size: 8.

The parent abort signal propagates to queued and running descendants. Parallel proposal tasks must declare likely paths before starting; exact normalized path claims are checked before execution, and produced DraftEdit URIs are checked again before merging. Conflicting later edits are omitted and reported instead of being silently combined.

## Persistence and continuation

Child data is stored below:

`globalStorageUri/chat-sessions/v1/subagents/<workspaceHash>/<parentSessionId>/`

Each child has a metadata file and a transcript file. Metadata records lineage, status, profile/lane, source/model, usage, and compatibility hashes for the source lane, system prompt, tool schema, profile, and project instructions. Continuation is allowed only inside the same parent session and only when all compatibility hashes still match. Otherwise it fails closed and the caller must start a new child.

Provider usage emitted by children is attributed to the `subagent` usage source in the parent turn. Each child accumulates its own Provider events during execution, including usage incurred before failure or cancellation; nested events are forwarded once and attributed to their own child summaries, not counted again in their ancestors.

## Usage details and context isolation

Hover/focus the context ring for a compact usage summary; click it or press Enter/Space for the accessible **Usage details** dialog. Escape closes it and returns focus. The dialog separates Provider actual usage (session or last turn), local context-isolation estimates, and child model/account, profile/lane, and recent-run statistics. Failed/stopped runs remain visible. No child task, result, reasoning, tool trace, or error details are sent in the statistics or progress state.

`ChatSession.subagentUsageStats` is an optional, strictly normalized schema-v1 statistics record. Runs are updated idempotently by `subagentId`; the latest 50 detailed summaries are retained, with cumulative totals and minimal ID-only deduplication ledgers preserved beyond that limit. Child metadata optionally stores the same numeric summary for recovery. Old protocol v1-v5 sessions remain readable; missing historical estimates are shown as unavailable, never reconstructed from prompt tokens.

The isolated-intermediate estimate is the sum of each child's **new** internal tool-call, tool-result, and reasoning estimates. Returned-context estimates observe only the three root subagent tool results after shaping and both budget checks, including parallel wrappers and paginated reads. The isolation rate is `isolated / (isolated + returned)`; a zero denominator has no percentage. These local estimates are **not billed Token savings** and do not predict what a run without subagents would have cost.

See [Usage statistics measurement and validation](doc/subagent-usage-statistics.md) for attribution, currency/cache completeness, limitations, and test coverage. These observers do not change Provider requests, tool schemas, prompts, the global child-model setting, or protocol version 5.
