# Changelog

## 0.1.7 - 2026-07-18

- Version bump for v0.1.7 release.

## 0.1.6 - 2026-07-15
- Fixed context entry points for editor selections, Explorer files/folders, and terminal selections, including the contributed menu commands and KeepSeek view focus target.
- Improved file and directory reference coverage with tests for selected line/column expansion, directory manifests, and Explorer multi-selection de-duplication.
- Added discovery for skills bundled in workspace and personal Codex plugin directories, alongside existing workspace `.agents` and user Codex skills.
- Removed the Agent execution-budget settings page and moved runtime limits, output budgets, tool budgets, and compression thresholds into fixed DeepSeek V4 model/Thinking profiles.
- Updated runtime documentation for always-on history projection, automatic profiles, and background context-compression refresh.

## 0.1.5 - 2026-07-11

- Version bump for v0.1.5 release.

## 0.1.3 - 2026-07-05

- Added usage and cost visibility for Agent runs, including turn/session tokens, prompt-cache hit rate, estimated cost, turn count, context percentage, compaction threshold, and DeepSeek balance.
- Added prompt-cache diagnostics and a lean default tool schema so KeepSeek can keep stable core tools hot while adding broader workspace tools only when the current request needs them.
- Added configurable usage pricing, DeepSeek balance endpoint/refresh interval, replay-safe request retries, and structured interaction trace logs.
- Improved context compaction controls with soft compaction, tool-result snipping, force-compaction thresholds, and an updated default summary trigger ratio of 0.8.
- Moved usage metrics into the context progress tooltip and removed per-keystroke expanded prompt usage estimation to reduce Webview-to-extension chatter before send.
- Updated release metadata, marketplace packaging scripts, and VSIX packaging exclusions for the 0.1.3 publish.

## 0.1.2 - 2026-06-27

- Added Codex-compatible KeepSeek Skills support, including discovery from workspace `.agents` and user Codex skills, active-skill selection, prompt skill references, and safe loading of referenced instruction resources.
- Added `/skills` and `/create-skill` flows so users can browse reusable workflows or create a workspace skill draft under `.agents/skills/.../SKILL.md`.
- Added the Agent budget/context settings UI for context compression, recent-turn retention, summary budget, tool budgets, and history retention.
- Added the About dialog with extension version, maintainer, repository, and license information.
- Improved external file reference and drag/drop reference handling so authorized references render and open more consistently.

## 0.1.1 - 2026-06-02

- Added two new read-only workspace tools:
  - `keepseek_search_workspace` for low-cost workspace search with bounded context output.
  - `keepseek_read_workspace_file_range` for bounded line-range reads with byte-size safeguards.
- Added first-pass tool result shaping and ledger metadata for search/range/read tool outputs, including truncation and compressed-size indicators to keep tool context stable and low-cost.
- Updated `keepseek_read_workspace_file` to return a structured fallback for oversized files and guide agents to use `keepseek_read_workspace_file_range` instead.
- Updated system prompt workflow (CN/EN): prefer `search/list` → `read_workspace_file_range` and only use full-file read when files are small or complete context is truly needed.
- Added new runtime phases and UI visibility updates for search/range phases so activity states and i18n labels stay consistent.
- Added usage accounting scaffolding: trace-level upstream usage aggregation while preserving existing prompt token estimate behavior.
- Updated `doc/keepseek-agent-runtime-workflow.md` to reflect the post-refactor runtime flow and tool strategy.

## 0.1.0 - 2026-05-27

- Added project-aware global history session storage with current-project and other-project browsing, cross-project session copy, favorites, rename, recent-day filtering, multi-select deletion, and whole-project history cleanup.
- Added `keepseek.historyRetentionDays` for the default history menu range, with stored sessions hard-pruned after 60 days except for the currently active session.
- Added an abort/stop control so users can cancel an in-progress Agent run from the composer.
- Added one-click copy for assistant replies.
- Shared Emacs-style text shortcuts across the prompt composer and message edit boxes.
- Improved file and directory reference rendering, line/column reference handling, reference type detection, and syntax highlighting for references in prompts and transcripts.

## 0.0.9 - 2026-05-24

- Fixed a streaming parser edge case where the final SSE event could be left unprocessed when the response ended with pending decoded bytes, causing AI replies to appear interrupted.

## 0.0.6 - 2026-05-24

- Added rich rendering for assistant markdown replies, including fenced code blocks and tables.
- Raised the default generated-token budget and exposed `keepseek.maxTokens` so Thinking responses are less likely to exhaust output tokens before the final answer.
- Added a DeepSeek V4 DSML tool-call fallback parser so leaked `<｜DSML｜tool_calls>` blocks are executed instead of shown as interrupted replies.
- Bumped the VSIX version so installed Windows builds refresh the webview code instead of reusing an older same-version package.

## 0.0.3 - 2026-05-23

- Added terminal, output, and debug console selection references so runtime logs can be inserted into the KeepSeek prompt as AI-readable context.
- Added `Cmd+L` / `Ctrl+L` shortcuts for terminal and debug console context capture.
- Reworked README content into a user-facing Chinese and English product overview for release.

## 0.0.1-beta.1

- Initial beta release of KeepSeek VS Code extension.
