# Changelog

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
