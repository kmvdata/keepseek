---
name: keepseek-context-reference-maintainer
description: KeepSeek prompt reference maintenance workflow. Use when Codex works on file references, directory references, Explorer/editor context insertion, terminal/output/debug-console text references, drag-and-drop references, external authorization, @ completion resources, prompt reference expansion, or reference opener behavior.
---

# KeepSeek Context Reference Maintainer

## Overview

Use this skill when a change touches how user-selected files, directories, line ranges, columns, or copied terminal/output text become prompt context.

## Reference Contracts

- Full file: `filename <path>`.
- Line range: `filename (line N-M) <path#LN-LM>`.
- Column range: `filename (line N column C-D) <path#LNCx-Cy>`.
- Directory: `dirname/ <keepseek-dir:path>`.
- `startLine: 0, endLine: 0` means full-file reference.
- Directory references expand to an anchor, usage guidance, and a limited manifest, not full file contents.

## Owner Files

- `src/context/references/fileReference.ts`: file syntax parsing, authorization, expansion.
- `src/context/references/directoryReference.ts`: directory syntax parsing, authorization, manifest expansion.
- `src/context/references/promptReferences.ts`: unified expansion entry point.
- `src/context/references/fileReferenceOpener.ts`: click/double-click open behavior.
- `src/context/references/referenceResources.ts`: `@` completion resources.
- `src/context/references/referenceSyntax.ts`: syntax safety and Markdown fence checks.
- `src/context/textReferences.ts`: terminal, output, and debug-console selection files.
- `src/webview/input/script.ts`: rich file/directory chips, insertion, drag-drop, `@` UI, prompt serialization.
- `src/webview/script.ts`: transcript-side deserialization/opening behavior.
- `src/provider/KeepseekChatViewProvider.ts`: command entry points and authorization handoff.

## Change Workflow

1. Identify whether the bug is in insertion, serialization, expansion, authorization, display, or opening.
2. Keep Webview chip rendering and serialization compatible with extension-side parsers.
3. Keep expansion conservative:
   - Workspace files and directories may expand.
   - External files and directories require prior authorization by `uri.toString()`.
   - Binary, media, archive, over-limit, unreadable, and unauthorized references stay as references.
4. Reuse `shared/textFileGuards.ts`, `shared/markdown.ts`, and `shared/format.ts` rather than duplicating checks.
5. If reference text format changes, update every parser, serializer, and opener path together.

## Verification

Run `npm run compile`. Manually name the affected reference flows to test: full-file reference, line/column reference, directory reference, external authorization, unreadable/binary skip, Explorer insertion, editor selection, drag-drop, `@` completion, and click-to-open.
