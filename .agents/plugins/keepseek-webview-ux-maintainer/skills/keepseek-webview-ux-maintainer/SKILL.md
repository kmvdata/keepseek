---
name: keepseek-webview-ux-maintainer
description: KeepSeek Webview UI and interaction maintenance workflow. Use when Codex works on webview/template.ts, webview/styles.ts, webview/script.ts, webview/input/*, richTextShortcuts.ts, prompt input behavior, transcript rendering, settings/session UI, drag-drop, @ references, keyboard shortcuts, or Webview message wiring.
---

# KeepSeek Webview UX Maintainer

## Overview

Use this skill for KeepSeek UI work inside the VS Code webview. Preserve the split between the main transcript/settings/session surface and the prompt input surface.

## File Ownership

- `src/webview/html.ts`: CSP, nonce, logo URI, final HTML assembly.
- `src/webview/template.ts`: main HTML skeleton string.
- `src/webview/styles.ts`: main Webview CSS string.
- `src/webview/script.ts`: transcript, sessions, settings, DraftEdit UI, render loop, Webview listeners.
- `src/webview/input/template.ts`: prompt input HTML string.
- `src/webview/input/styles.ts`: input-only CSS string.
- `src/webview/input/script.ts`: rich prompt input, chips, drag-drop, `@` menu, command menu.
- `src/webview/richTextShortcuts.ts`: shared shortcuts for bottom prompt and message edit inputs.

## Interaction Rules

- Do not duplicate rich-text shortcut behavior in multiple editors; use `richTextShortcuts.ts`.
- Keep `WebviewMessage` changes in `provider/webviewMessages.ts` plus Provider and Webview senders.
- Keep extension-to-Webview push messages out of `WebviewMessage`, but handle them in the Webview listener.
- Preserve existing DOM ids and serialized reference formats unless the full extension/Webview contract is changed.
- Keep text inside controls responsive and non-overlapping at narrow sidebar widths.
- Prefer quiet, dense, VS Code-appropriate interactions over marketing-style layouts.

## Change Workflow

1. Find the narrowest owner file for the requested interaction.
2. Read the corresponding template, styles, and script together if the change spans markup, layout, and behavior.
3. For input changes, verify prompt serialization, chip insertion, saved cursor behavior, drag-drop, `@` resources, and command menu interactions.
4. For transcript/settings/session changes, verify `state` updates flow through `render()` and do not require extension-only state in the Webview.
5. For keyboard changes, test both bottom prompt and message edit inputs.

## Verification

Run `npm run compile`. For shortcut or input changes, explicitly cover Emacs movement, mark/region, `Ctrl-K`, `Ctrl-W`, `Alt-W`, `Ctrl-Y`, and native `Command-A/C/X/V/Z` expectations.
