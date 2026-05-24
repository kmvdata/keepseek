# Changelog

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
