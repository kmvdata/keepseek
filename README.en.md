> **中文版：[README.md](./README.md) | English version: this file**

## Who is KeepSeek for?

> **Cursor's feel × Reasonix's savings × DeepSeek's low price — all in VS Code.**

If what you want is a **VS Code DeepSeek agent extension** with interaction as smooth as Cursor and token savings as extreme as Reasonix, **KeepSeek is your answer**.

If any of the following sounds like you, KeepSeek was built for you:

- **You admire Cursor's interaction but don't want to leave VS Code** — sidebar chat, right-click selections, `Cmd+L` quick references, dragging files into the input box... KeepSeek reproduces Cursor's native feel right inside VS Code: no editor switch, no habit changes, no migration hassle;
- **You treat tokens like money, the Reasonix way** — prefix cache hits cost as little as **1/30 of the full input price**; every turn of a long conversation reuses the previous turn's cache, so the longer you chat, the more you save — instead of paying more and more;
- **You want an agent that truly "understands code"** — semantic navigation, read-only exploration, line-range reads: the AI always sees your latest code, not stale text from turns ago;
- **You have zero tolerance for AI silently editing files** — every modification is presented as a DraftEdit and nothing touches disk until you confirm; read-only tools never leave the workspace.

**If even one of these resonates, keep reading** — here's how KeepSeek gives you Cursor's feel, Reasonix's savings, and DeepSeek's low price, all at once.

# KeepSeek: A VS Code Coding Assistant That Fully Exploits DeepSeek's Prefix Cache

> **Same tasks, fewer tokens, lower cost, faster responses.**
> KeepSeek is an AI coding assistant (Agent Chat) living in the VS Code sidebar. It feels as native and effortless as Cursor: no window switching, no copy-paste — right-click, shortcuts, or drag-and-drop hand your selections, files, and logs to the AI. It treats "context" as a precise craft — sending only the files, selections, and logs you choose, so DeepSeek's **prefix cache** keeps hitting across multi-turn conversations (cache-hit input costs as little as **1/30 of the full price**).
> For developers building projects with AI, KeepSeek is also a professional code-reading tool: semantic navigation, read-only search, line-range reads — you stay in control of your architecture at every step. Every turn of a long conversation pays for the content you already have, instead of buying it all over again.

**Open source · MIT License · GitHub: [https://github.com/kmvdata/keepseek](https://github.com/kmvdata/keepseek)**

---

## 1. Why does KeepSeek save tokens? Because cache hit rate is product behavior, not luck

DeepSeek's billing hides a fact most people overlook: **tokens that hit the prefix cache cost 1/30 of regular input**.

Since **August 17, 2026**, DeepSeek switched to **peak/off-peak pricing**, but the cache-hit discount ratio stays the same whether it's peak or off-peak. KeepSeek's reference price table:

| Model | Time | Regular input | Cache hit | Gap |
|---|---|---:|---:|---:|
| DeepSeek V4 Flash | Off-peak | ¥1.5 / 1M tokens | ¥0.05 / 1M tokens | **30x** |
| DeepSeek V4 Flash | Peak | ¥3.0 / 1M tokens | ¥0.10 / 1M tokens | **30x** |
| DeepSeek V4 Pro | Off-peak | ¥4.5 / 1M tokens | ¥0.15 / 1M tokens | **30x** |
| DeepSeek V4 Pro | Peak | ¥9.0 / 1M tokens | ¥0.30 / 1M tokens | **30x** |

> **Peak hours** are Beijing-time daily **9:00-12:00** and **14:00-18:00**; all other times are off-peak.

At off-peak pricing: a 1M-token input costs ¥1.5 (Flash) or ¥4.5 (Pro) at full price; **if the cache hits, it costs only ¥0.05 / ¥0.15**. In an agent's multi-turn session, history messages + tool definitions + system prompt usually make up the vast majority of every request — and they are re-sent every turn. Hit or miss is a difference of about an order of magnitude (roughly 30x).

The cache rule is brutal: the request prefix must be **byte-for-byte identical from token 0** for the hit portion to be billed at the discounted rate; any byte drift at any point makes **the entire prefix after that point miss**, and everything is re-billed at full price.

Most agent clients leave this to luck:

- Re-wrapping history messages with a different template every turn → byte drift → the whole prefix is wasted;
- Timestamps, random IDs, and activation reasons baked into the system section → that whole section misses every turn;
- History sliding, reordering, or trimming within a window → any rewrite in the middle invalidates everything after it;
- Tool schemas changing with the prompt → the tools prefix never matches;
- Session summaries refreshed too often → low-frequency content rewritten at high frequency, treating the cache like a disposable item.

The result: **long conversations get more expensive as they go — turn N effectively re-sends turns 1 through N-1 at full price.**

KeepSeek does the opposite: **the request prefix is frozen, history is append-only, and the cache is sustainable.** In multi-turn sessions, the prefix hits all the way from token 0 to the end of the previous turn, and only the newly appended messages of the current turn are billed at full price — **hit rate approaches 100% as turns accumulate**.

> This isn't marketing talk; it's a byte-level contract. Dedicated tests (`test/cacheByteStability.test.ts`, `test/protocolCache.test.ts`) guard these invariants — any change that breaks prefix stability turns CI red.

---

## 2. The cache-friendly architecture: four pillars

### Pillar 1: Byte-frozen request prefix

KeepSeek has a hard contract on "sent bytes", baked into the architecture:

- **Fully static system section**: core safety rules and tool permission boundaries never change over time;
- **Persisted contextInstructions reuse**: formatted AGENTS.md / Skills / Context Files output is stored in the session; if the bytes haven't changed, they're reused byte-for-byte, never regenerated each turn;
- **User messages: "sent bytes == persisted bytes"**: `(expandedContent ?? content).trim()` is sent as-is — no wrapping or concatenation at send time;
- **Assistant messages restored byte-for-byte**: tool turns (tool_calls / tool results) and `reasoning_content` are persisted as-is and rebuilt across turns without byte changes;
- **Dynamic content is only appended at the tail of user messages**: goals, temporary instructions, and background state never rewrite already-sent history.

> Result: **the prefix sent to the model in turn 1 still appears byte-for-byte at the same position in turn 50.** The cache accumulates from the first turn instead of resetting every turn.

### Pillar 2: Append-only history projection

KeepSeek's model input is a projection, not "dumping the chat log into the request":

- Messages entering the projection are **append-only: never rewritten, trimmed, or reordered**;
- Sliding the recent window never "externally rewrites" old messages — old messages are either kept as-is or bulk-replaced when the summary refreshes;
- Mid-history is never rewritten on its own, because any byte change there invalidates the entire cache suffix.

### Pillar 3: Low-frequency summary refresh (cache resets are controlled)

The compressed summary (synthetic summary) of a long conversation is one of the few moments when the prefix must be rewritten — KeepSeek treats it as a **controlled cache reset point**:

- The summary trigger threshold is **deliberately raised** (refresh only when ≥48 compressible messages have accumulated and the ratio crosses a threshold), avoiding frequent rewrites of the synthetic summary and mass removal of covered messages that would invalidate the prefix wholesale;
- Summary output is budget-limited, thinking is off, timeout is short; failures only record a reason and **never block normal requests**;
- After a failed refresh, summary refresh auto-locks (C3 failure self-lock), so it doesn't keep reopening the wound while the cache is already injured.

### Pillar 4: Tool schemas frozen per session

KeepSeek's tool set stays constant within a session — the tool schema set and order don't change with each prompt (schemas are normalized, keys sorted, byte-stable across turns). Slim tool mode is off by default for the same reason: **the smaller and more stable the exposed schema, the easier the tools prefix hits.**

Since 0.2.2, KeepSeek goes further: **it persists the request protocol, serialization, tool schema, and Provider/model/endpoint details per session; each tool turn keeps the fully frozen tools schema, and when a tool becomes forbidden it switches to `tool_choice: none` instead of removing tools** — so one "disable tool" never breaks the cache. It also adds a **configurable cache TTL** (`keepseek.promptCacheTtlMinutes`, default 1440 minutes), splitting the context into a fixed system prefix and append-only per-turn updates.

---

## 3. Context compression: total tokens saved too

The cache solves the "unit price"; context compression solves the "total volume". Together they are real savings:

- **History projection**: system prompt + session summary + protected key messages + recent turns + current input, organized into a single request;
- **Summaries keep only clues**: goals, decisions, errors, file paths, line ranges, function names, completed items, and todos — **not the large file bodies, logs, and code blocks that recurred in old history**;
- **File references externalized**: expanded file content in history keeps only a path clue; when the model needs code details, it **re-reads the current file** through read-only workspace tools;
- **Automatic protection**: the first requirement, the latest input, explicit "remember this" messages, important errors/test failures, user corrections, and DraftEdit results are never covered by summaries.

Since 0.2.2, the compression pipeline is upgraded to a **cache-safe Snip → Prune → Summary pipeline**:

- **Hot sessions never rewrite history or start paid background summaries** — only cold recovery or necessary compression archives and prunes stale tool output;
- Summary coverage advances **only after successful requests** — overflow is left for a later batch, failures don't advance coverage, and new summaries are **appended as immutable segments** instead of rewriting the old one;
- **Persistent local session archiving + scoped search**: full raw tool output no longer disappears with compression; errors, failed tests, validation output, and high-risk edit/delete results are protected from automatic cleanup;
- Pick an auto-compression tier: **70% early cleanup / 80% balanced / 85% cache-first**, persisted per workspace and overriding the model default.

> Typical effect: long sessions that reference files, drag in logs, and expand large code blocks go from "linear bloat" to "stable growth" in token consumption.

---

## 4. Visible cache health: diagnostics, attribution & usage

KeepSeek doesn't make you guess what you spent in a black box:

- **Source + model usage attribution**: usage is grouped by account and model first, then by execution, summary, retry, continuation, background, and other sources inside each group. Unpriced requests say “Cost unavailable,” and different currencies are never added together;
- **Unified Provider request projection (0.2.2)**: the actual request, context/token estimation, overflow guard, compression decisions, UI usage, and cache tests all use **the same projection** — what you see is exactly what gets sent;
- **Cost estimation**: estimated in real time from the local price table (`keepseek.usagePricing` is customizable);
- **Context usage**: current context as a percentage of the model window, compression trigger thresholds, and early warnings before you hit the compression line;
- **DeepSeek balance**: auto-queried and displayed, so you always know where you stand;
- **Per-run cache snapshots**: every completed assistant Run Details records provider-reported hit/miss tokens, hit rate, data availability, and cache-lane changes. Raw endpoints and internal hashes are not exposed to the Webview;
- **Miss attribution**: the usage popover and per-run details explain model, source, protocol, endpoint/cache lane, system prompt, tool schema, history compaction/rewrite, and possible provider eviction. A turn is called a miss only when real provider miss data exists.

Model selection becomes effective only after extension-side validation. A foreground response can queue and cancel a “next-turn model”; non-terminal background tasks lock the model. Switching to a smaller context window or across a provider-native replay boundary shows one local confirmation based on the target model’s real window and the authoritative context projection, without making an extra model request for preview or statistics.

> Other clients: hit rate is a black box; when it drops, you have no idea why.
> KeepSeek: hit rate is a dashboard; when it drops, it tells you exactly which component changed.

---

## 5. What the saved time and money look like

Rough estimate with a 100K-token prefix, 50-turn conversation, Flash model at off-peak pricing (input side only):

| | Ordinary client | KeepSeek |
|---|---:|---:|
| Turn 1: 100K prefix | Full price ¥0.15 | Full price ¥0.15 |
| Turns 2–50: 100K prefix (assuming hit) | ¥0.15 per turn at full price (if cache drifts) | ¥0.005 per turn |
| 50-turn input cost | ≈ ¥7.5 (all full price) | ≈ ¥0.40 (with hits) |

Add context compression's cut to the **total volume** on top: KeepSeek's long sessions don't carry every historical file body on their back each turn.

---

## 6. Accounts, models & Skills: an extension system that just works

### Multi-account management (0.2.3): official DeepSeek, OpenAI-compatible & local Ollama, all in one place

KeepSeek's account system doesn't limit which models you combine — **official DeepSeek, OpenAI-compatible services, and local Ollama** can live side by side in the sidebar, each independent and instantly switchable:

- **Multiple accounts coexist, switch in one click**: official DeepSeek, any OpenAI-compatible endpoint, and local Ollama (`http://localhost:11434`) each configure as independent accounts; keep several at once, with **one-click active-account switching** and physical deletion whenever you want;
- **Ollama needs no API key**: local deployments work without a secret (no Authorization header is sent when the key is empty), and Base URLs missing `/v1` are auto-completed — just paste `http://localhost:11434` and connect;
- **Several models per account + model aliases**: the model switcher groups models by account, so you can call different sources with names you like (aliases), with the full model ID kept in a tooltip;
- **Unified account traffic**: chat requests, context summaries, and balance refreshes flow through the current active account; balance snapshots and query frequency are tracked independently per account;
- **Capability gaps adapt automatically**: only an official DeepSeek source (`provider=deepseek` with Base URL host `api.deepseek.com`) keeps balance and cost reporting; OpenAI-compatible, proxy, and Ollama sources automatically fall back to chat completions / tool calling / token stats and never misreport a balance;
- **Legacy config is dropped**: old `keepseek.apiKey` / `keepseek.baseUrl` and `DEEPSEEK_API_KEY` environment values are ignored; configure accounts in the model settings dialog instead.

### The only extension mechanism for agents: Skills (0.2.2)

Write project conventions, debugging playbooks, and team prompts as **Skills** (discoverable in workspace `.agents` and `~/.codex/skills`). KeepSeek lets you browse with `/skills`, invoke with `$`, and draft with `/create-skill`; clicking a Skill tag in the use bar opens its SKILL.md in VS Code (Enter/Space accessible). From now on, extending the world is **one path only** — clean, controlled, no rewriting.

### Stable tooling, ready at hand

- **Tool schemas frozen per session**: the tool set and order stay byte-stable across turns — clicks, multi-step reasoning all work as usual, but the tools prefix never deforms;
- **Optimized large-file handling (0.2.2)**: line-range reads gain a `hasMore` / `nextStartLine` continuation cursor; new `keepseek_create_incremental_draft_edit` supports exact unique search-replace, range replacement, and multi-edit in one file — **refusing rather than guessing** on missing, ambiguous, or overlapping targets, so you never dump a whole big file into the model;
- **Less redundant input (0.2.2)**: ordinary replies no longer re-send reasoning content (while tool-call-related content stays stable), saving even more tokens.

---

## 7. Native experience as smooth as Cursor

KeepSeek doesn't sacrifice experience to save money — it turns everyday operations into native VS Code interactions, Cursor-style:

### Sidebar chat: ask while reading code

KeepSeek lives in the VS Code Secondary Sidebar — no window switching, no copy-paste. Supports DeepSeek V4 Flash / Pro dual models and Thinking modes (`high` / `max` reasoning), with coding parameters (1M context window, output/tool budgets, compression thresholds) automatically applied per model and tier.

### Context: only what you choose

- **Editor selections**: right-click or `Cmd+L` / `Ctrl+L` to add, preserving file path, line, and column;
- **Explorer files/directories**: right-click to add, or drag them into the input box to generate reference chips;
- **Live runtime**: selections in the terminal, Output panel, and Debug Console join as `.log` references, so the AI analyzes real runtime state;
- **Precise line ranges**: `<path#L10-L20>` references expand only the part you need — never the whole file.

### Agent tools designed to be "low-cost"

- Read-only workspace search (literal/regex, path/include scoping, case matching) + line-range reads — **not web search, not search-and-replace**;
- Declaration and reference lookup prefer VS Code semantic providers (symbol/reference) — more accurate and cheaper;
- Dependency, build, and VCS directories are auto-skipped; binary, media, archive, and oversized files never enter context.

### Engineering conveniences

- **Validate and repair**: the agent can run controlled `bun run compile / lint / test`, read Problems on failure, prepare fix drafts, loop, and wait for your confirmation;
- **Stop anytime**: halt the current run mid-reasoning or mid-tool-loop;
- **Retry on disconnect**: recoverable errors before the first chunk retry automatically with exponential backoff;
- **Cross-project continuity**: sessions are saved per project — browse other projects, copy into the current one, bookmark, rename, filter by time, multi-select delete. Switch workspaces without losing your train of thought;
- **Background running**: mutually exclusive and serial at any moment, so the session prefix is never concurrently rewritten (this is also part of cache stability).

---

## 8. A partner for AI-built projects: keep the architectural rhythm in your hands

AI codegen is getting faster, but the architecture, dependency graph, and module boundaries still need a human hand. KeepSeek is not just a chat window — it's a **professional code-reading tool**, the piece AI-built projects overlook most and need most:

- **Semantic navigation, not guesswork**: declaration and reference lookup prefer VS Code language services (symbol / reference providers) — jump and see call relationships more accurately and for fewer tokens;
- **Read-only exploration, zero side effects**: workspace search (literal/regex, path/include scoping, case matching), line-range reads, and directory listings are all read-only, never leaving the workspace;
- **Re-read on demand, never misled by stale code**: in long sessions, when the model needs code details it **re-reads the current file** with read-only tools, rather than citing bodies expanded turns ago — the code you changed is what the AI always sees;
- **Read-only Git assistance**: branch, status, diff, patch, and commit-message suggestions give you the full picture of changes — but it never pushes and never commits for you;
- **Context visualization**: current context as a percentage of the model window, compression thresholds at a glance, early warnings before compression — architecture discussions can run as long as you like without losing control.

For developers building projects with AI, KeepSeek lets you switch between "AI writes code" and "human steers architecture" at will: let the AI do the work while using KeepSeek to read code, check references, and review diffs — pacing every step.

---

## 9. Privacy & security: every modification is your call

- **No silent writes, ever**: the AI can only prepare DraftEdits, which enter a ChangeSet where you review the diff and choose Apply / Discard / Revert; **create/modify touches disk only when you click Apply**;
- **Double confirmation for deletion**: high-risk tool-call modal + a dedicated deletion modal before Apply; if the file changed after the draft was prepared, deletion is refused to avoid removing new content;
- **Read-only boundaries**: the agent's read-only tools never leave the current workspace; dependency, build, and VCS directories are auto-skipped; binary, image, media, archive, and oversized files never enter context;
- **Explicit authorization**: only content you explicitly add is read; external files and dragged-in files require authorization before expansion;
- **Privacy by default**: terminal/debug selections live as temporary `.log` files in the extension's global storage; trace logging is off by default;
- **Fail-safe self-lock**: failed summary refreshes auto-lock and pause, without repeatedly retrying and hurting the cache or the context window.

---

## 10. Who it's for

- **Pay-as-you-go DeepSeek users**: people who want their API bill down by an order of magnitude — KeepSeek is built for this;
- **Heavy agent users**: dozens of turns a day, endless long sessions — every turn saves money;
- **Engineers building projects with AI**: need a professional code-reading tool to keep the architectural rhythm and the full picture of changes;
- **Indie developers**: complete code reading, issue triage, and solution discussion in a lightweight sidebar;
- **Team engineers**: hand real code and real runtime output to the AI, cutting the back-and-forth of context copy-paste;
- **New team members / reviewers**: understand the structure fast; review precisely around files, line numbers, and logs.

---

## 11. Quick start (3 steps)

```bash
# 1. Build and install the VSIX (local use)
bun run package          # generates keepseek-<version>.vsix
code --install-extension keepseek-<version>.vsix

# One-command reinstall verification: package → uninstall old → install new
bun run reinstall:vsix
```

```text
# 2. Open it in VS Code
KeepSeek: Open Agent Chat
```

```text
# 3. Open “Models and sources” in KeepSeek settings, then add a model with its API key and Base URL
# Legacy settings (keepseek.apiKey / keepseek.baseUrl / DEEPSEEK_API_KEY) are no longer supported and are ignored
```

Then select some code, press `Cmd+L` / `Ctrl+L` (or right-click → KeepSeek: Add Selection to Chat), and ask your first question. Open the usage stats and compare the hit rates of turn 1 and turn 2 — those two numbers are the reason KeepSeek exists.

### Testing and marketplace packaging (maintainers)

```bash
# Run the full test suite
bun run build:test       # compiles tests into out-test/
bun run test             # runs the tests

# Lint
bun run lint
```

```bash
# Package for the marketplace (recommended; includes verification)
bun run package:market
```

`package:market` first confirms that runtime dependencies (e.g. `ignore`) are installed, cleans `out/`, recompiles, packages with `vsce package --dependencies`, and runs `verify-vsix.js` to confirm the VSIX contains the runtime dependencies and the `main` entry. When verification passes, the generated `keepseek-<version>.vsix` is ready to upload to a marketplace. **Never** run bare `npx vsce package --no-dependencies` — the resulting package lacks runtime dependencies and the extension will fail to activate after installation from a marketplace.

### Multiple model sources

- A model source stores one `provider + API key + Base URL` connection and can own multiple models. Adding another model with matching connection details reuses that source and does not duplicate credentials.
- The model switcher aggregates every source and groups models by source. Requests and summaries use the selected model's source; there is no separate active-account state.
- Only a `deepseek` source whose Base URL host is exactly `api.deepseek.com` supports automatic discovery, balance, and cost reporting. DeepSeek proxies and OpenAI-compatible sources report tokens only.
- A failed model refresh silently keeps the last cache and never blocks chat. If an OpenAI-compatible endpoint does not expose `/models`, add its model ID manually in settings.
- Source files live only in VS Code extension global storage, never in the workspace or Git: `<globalStorageUri>/accounts/<provider>/<sourceId>.json`; official-source balance data lives at `<globalStorageUri>/accounts/<provider>/<sourceId>/balance.json`.
- Legacy `keepseek.apiKey` / `keepseek.baseUrl` and `DEEPSEEK_API_KEY` environment values are no longer read; they are dropped and ignored. Accounts are managed exclusively through the model settings dialog.

### Auto-compression tiers

In the command menu's model area you can pick a compression strategy directly: **70% early cleanup** (lower latency and lighter tokens), **80% balanced** (recommended default), and **85% cache-first** (maximize prefix cache hits). The choice is persisted per workspace and overrides the model's built-in default tier.

---

## 12. Cost-related configuration cheat sheet

| Setting key | Default | Description |
|--------|--------|------|
| `keepseek.selectedSourceId` | `""` | Paired with `selectedModelId` to persist the selected model source for this workspace |
| `keepseek.usagePricing` | DeepSeek default price list | Applies only to official DeepSeek sources; unknown models no longer inherit another model's rates |
| `keepseek.balanceEndpointUrl` | `""` | Balance query endpoint; when empty, derived from `baseUrl` as `/user/balance` |
| `keepseek.balanceRefreshIntervalMs` | `60000` | Minimum interval for automatic balance refresh |
| `keepseek.slimToolModeEnabled` | `false` | **Off by default**: the full tool set keeps the tools section byte-stable for sustained cache hits; enabling it trades a smaller schema for a schema that varies with the prompt and lowers the hit rate |
| `keepseek.promptCacheTtlMinutes` | `1440` | Prompt cache TTL in minutes; proactively reconnects after expiry to refresh the cache window |
| `keepseek.maxFileBytes` | `200000` | Max bytes read for a single reference/workspace file, controlling context size |
| `keepseek.maxWorkspaceToolFiles` | `2000` | Max candidate files enumerated by read-only listings and search |
| `keepseek.maxRequestRetries` | `2` | Automatic retries before the first response chunk (exponential backoff) |
| `keepseek.historyRetentionDays` | `7` | Default time range shown in the history menu (storage hard-cleans at 60 days) |

Model & Thinking-tier output budgets, tool-turn limits, and summary trigger/force ratios are fixed internal tiers; context compression is always on.

---

## 13. Acknowledgments: tribute to Reasonix

KeepSeek's cache-friendly mechanisms directly borrow from **Reasonix**'s proven approach to "accomplishing agent tasks with minimal tokens": byte-stable request prefixes, append-only history that only grows, low-frequency summary refreshes, and per-session frozen tool schemas. These ideas were validated in Reasonix's practice; KeepSeek builds on them with engineering and product work tailored to DeepSeek's prefix-cache billing.

Sincere **thanks** to Reasonix and its developers — every token and every cent KeepSeek saves includes your contribution.

---

## 14. Further reading

- **Cache-hit optimization deep dive (maintainers/advanced)**: [doc/cache.md](./doc/cache.md), [doc/cache_keepseek.md](./doc/cache_keepseek.md)
- **Agent runtime workflow**: [doc/keepseek-agent-runtime-workflow.md](./doc/keepseek-agent-runtime-workflow.md)
- **File reference spec**: [doc/keepseek-file-reference-spec.md](./doc/keepseek-file-reference-spec.md)
- **Source code**: [https://github.com/kmvdata/keepseek](https://github.com/kmvdata/keepseek)

---

*KeepSeek is open source (MIT License); source at [github.com/kmvdata/keepseek](https://github.com/kmvdata/keepseek). Cache-friendliness is not a slogan — it's an engineering contract in `agent/historyProjection.ts`, `agent/historyCompressor.ts`, and `agent/runner.ts`.*

*KeepSeek in one line: KeepSeek is a VS Code sidebar agent that treats context as a precise craft — it sends only the files, selections, and logs you choose, and keeps DeepSeek's prompt prefix cache hot across turns, with cached input costing as little as 1/30 of the full price. It pairs Cursor-like native interactions with a professional read-only code navigation experience, so you stay in control of your architecture. Open source, MIT licensed.*
