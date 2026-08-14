> **中文版：[README.md](./README.md) | English version: this file**

## Who is KeepSeek for?

> **Cursor's feel × Reasonix's savings × DeepSeek's low price — all in VS Code.**

If what you want is a **VS Code DeepSeek agent extension** with interaction as smooth as Cursor and token savings as extreme as Reasonix, **KeepSeek is your answer**.

If any of the following sounds like you, KeepSeek was built for you:

- **You admire Cursor's interaction but don't want to leave VS Code** — sidebar chat, right-click selections, `Cmd+L` quick references, dragging files into the input box... KeepSeek reproduces Cursor's native feel right inside VS Code: no editor switch, no habit changes, no migration hassle;
- **You treat tokens like money, the Reasonix way** — prefix cache hits cost as little as **1/50 (Flash) to 1/120 (Pro)** of the full input price; every turn of a long conversation reuses the previous turn's cache, so the longer you chat, the more you save — instead of paying more and more;
- **You want an agent that truly "understands code"** — semantic navigation, read-only exploration, line-range reads: the AI always sees your latest code, not stale text from turns ago;
- **You have zero tolerance for AI silently editing files** — every modification is presented as a DraftEdit and nothing touches disk until you confirm; read-only tools never leave the workspace.

**If even one of these resonates, keep reading** — here's how KeepSeek gives you Cursor's feel, Reasonix's savings, and DeepSeek's low price, all at once.

# KeepSeek: A VS Code Coding Assistant That Fully Exploits DeepSeek's Prefix Cache

> **Same tasks, fewer tokens, lower cost, faster responses.**
> KeepSeek is an AI coding assistant (Agent Chat) living in the VS Code sidebar. It feels as native and effortless as Cursor: no window switching, no copy-paste — right-click, shortcuts, or drag-and-drop hand your selections, files, and logs to the AI. It treats "context" as a precise craft — sending only the files, selections, and logs you choose, so DeepSeek's **prefix cache** keeps hitting across multi-turn conversations (cache-hit input costs as little as **1/50 ~ 1/120** of the full price).
> For developers building projects with AI, KeepSeek is also a professional code-reading tool: semantic navigation, read-only search, line-range reads — you stay in control of your architecture at every step. Every turn of a long conversation pays for the content you already have, instead of buying it all over again.

**Open source · MIT License · GitHub: [https://github.com/kmvdata/keepseek](https://github.com/kmvdata/keepseek)**

---

## 1. Why does KeepSeek save tokens? Because cache hit rate is product behavior, not luck

DeepSeek's billing hides a fact most people overlook: **tokens that hit the prefix cache cost 1/50 ~ 1/120 of regular input**.

KeepSeek's default price table:

| Model | Regular input | Cache hit | Gap |
|---|---:|---:|---:|
| DeepSeek V4 Flash | ¥1 / 1M tokens | ¥0.02 / 1M tokens | **50x** |
| DeepSeek V4 Pro | ¥3 / 1M tokens | ¥0.025 / 1M tokens | **120x** |

In other words: a 1M-token input costs ¥1 (Flash) or ¥3 (Pro) at full price; **if the cache hits, it costs only ¥0.02 / ¥0.025**. In an agent's multi-turn session, history messages + tool definitions + system prompt usually make up the vast majority of every request — and they are re-sent every turn. Hit or miss is a difference of one to two orders of magnitude.

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

---

## 3. Context compression: total tokens saved too

The cache solves the "unit price"; context compression solves the "total volume". Together they are real savings:

- **History projection**: system prompt + session summary + protected key messages + recent turns + current input, organized into a single request;
- **Summaries keep only clues**: goals, decisions, errors, file paths, line ranges, function names, completed items, and todos — **not the large file bodies, logs, and code blocks that recurred in old history**;
- **File references externalized**: expanded file content in history keeps only a path clue; when the model needs code details, it **re-reads the current file** through read-only workspace tools;
- **Automatic protection**: the first requirement, the latest input, explicit "remember this" messages, important errors/test failures, user corrections, and DraftEdit results are never covered by summaries.

> Typical effect: long sessions that reference files, drag in logs, and expand large code blocks go from "linear bloat" to "stable growth" in token consumption.

---

## 4. Visible cache health: diagnostics and attribution

KeepSeek doesn't make you guess what you spent in a black box:

- **Per-run / per-session token stats**: input, output, cache hits and misses counted separately, with prompt cache hit/miss and hit-rate percentage shown every turn;
- **Cost estimation**: estimated in real time from the local price table (`keepseek.usagePricing` is customizable);
- **Context usage**: current context as a percentage of the model window, compression trigger thresholds, and early warnings before you hit the compression line;
- **DeepSeek balance**: auto-queried and displayed, so you always know where you stand;
- **Prefix fingerprints**: `systemPromptHash`, `toolsSchemaHash`, `historyPrefixHash` — recorded per request; compare across turns to confirm prefix stability;
- **Miss attribution**: when hit rate drops significantly, KeepSeek suggests candidate causes — `system_prompt_changed`, `tools_schema_changed`, `model_changed`, `history_compacted`, `history_prefix_changed`, `prefix_changed_or_provider_cache_evicted` — so you know which part broke the cache.

> Other clients: hit rate is a black box; when it drops, you have no idea why.
> KeepSeek: hit rate is a dashboard; when it drops, it tells you exactly which component changed.

---

## 5. What the saved time and money look like

Rough estimate with a 100K-token prefix, 50-turn conversation, Flash model (input side only):

| | Ordinary client | KeepSeek |
|---|---:|---:|
| Turn 1: 100K prefix | Full price ¥0.1 | Full price ¥0.1 |
| Turns 2–50: 100K prefix (assuming hit) | ¥0.1 per turn at full price (if cache drifts) | ¥0.002 per turn |
| 50-turn input cost | ≈ ¥5.0 (all full price) | ≈ ¥0.2 (with hits) |

Add context compression's cut to the **total volume** on top: KeepSeek's long sessions don't carry every historical file body on their back each turn.

---

## 6. Native experience as smooth as Cursor

KeepSeek doesn't sacrifice experience to save money — it turns everyday operations into native VS Code interactions, Cursor-style:

### Sidebar chat: ask while reading code

KeepSeek lives in the VS Code Secondary Sidebar — no window switching, no copy-paste. Supports DeepSeek V4 Flash / Pro dual models and Thinking modes (`high` / `max` reasoning intensity); model and tier automatically apply the matching programming parameters (1M context window, output/tool budgets, compression thresholds).

### Context: only what you want to give

- **Editor selections**: right-click or `Cmd+L` / `Ctrl+L` to add, preserving file path, line, and column;
- **Explorer files/directories**: right-click to add, or drag them straight into the input box to create reference chips;
- **Live runtime evidence**: selected content from the terminal, Output panel, or Debug Console added as `.log` references, so the AI analyzes real output;
- **Precise line ranges**: `<path#L10-L20>`-style references expand only the part you need — never the whole file.

### Agent tools designed for low cost

- Read-only workspace search (literal/regex, path/include scoping, case matching) + line-range reads — **not web search, not search-and-replace**;
- Declarations and references prefer VS Code semantic providers (symbol/reference) — more accurate and more token-efficient;
- Dependency, build, and VCS directories are auto-skipped; binary, media, archive, and oversized files never enter context.

### Reusable workflows (Skills)

Write project conventions, debugging playbooks, and team prompts as Skills (discoverable from `.agents` or `~/.codex/skills`); browse with `/skills`, invoke with `$` references, and generate drafts with `/create-skill`.

### Continue debugging across projects

History sessions are saved per project — browse other projects, copy to the current one, favorite, rename, filter by time, multi-select delete. Switch workspaces without losing your thread.

### Better engineering conveniences

- **Validate & fix**: the agent can run controlled `npm run compile / lint / test`, read Problems on failure, prepare fix drafts automatically, and loop until fixed — then wait for your confirmation;
- **Run cancellation**: stop the current run anytime during reasoning or the tool loop;
- **Disconnect retry**: retryable errors before the first response chunk get automatic exponential-backoff retries;
- **Background runs**: mutually exclusive and serialized — no concurrent runs that would rewrite the session prefix (this is also part of cache stability).

---

## 7. A partner for AI-driven development: keep the architectural rhythm in your hands

AI-generated code gets faster every day, but architecture, dependencies, and module boundaries still need a human at the wheel. KeepSeek isn't just a chat window — it's a **professional code-reading tool**, the piece most overlooked and most needed when building projects with AI:

- **Semantic navigation, not guessing**: finding declarations and references goes through VS Code language services (symbol/reference providers) first — one-click jumps and call-relationship inspection, more accurate than full-text search and cheaper in tokens;
- **Read-only exploration, zero side effects**: workspace search (literal/regex, path/include scoping, case matching), line-range reads, directory listings — all read-only, never leaving the workspace;
- **Re-read on demand, never misled by stale code**: in long sessions, when the model needs code details it **re-reads the current file** through read-only tools, instead of referencing old bodies expanded turns ago — the code the AI sees is always the latest state after your edits;
- **Git read-only assistance**: branch, status, diff, patch, and commit-message suggestions give you the full picture of changes — but it never pushes and never commits for you;
- **Context visualization**: current context as a percentage of the model window, compression thresholds at a glance, early warnings before compression — architecture discussions can run as long as you like without losing control.

For developers building projects with AI, KeepSeek lets you switch between "AI writes code" and "human steers architecture" at will: let the AI do the work while using KeepSeek to read code, check references, and review diffs — pacing every step.

---

## 8. Privacy & security: every modification is your call

- **No silent writes, ever**: the AI can only prepare DraftEdits, which enter a ChangeSet where you review the diff and choose Apply / Discard / Revert; **create/modify touches disk only when you click Apply**;
- **Double confirmation for deletion**: high-risk tool-call modal + a dedicated deletion modal before Apply; if the file changed after the draft was prepared, deletion is refused to avoid removing new content;
- **Read-only boundaries**: the agent's read-only tools never leave the current workspace; dependency, build, and VCS directories are auto-skipped; binary, image, media, archive, and oversized files never enter context;
- **Explicit authorization**: only content you explicitly add is read; external files and dragged-in files require authorization before expansion;
- **Privacy by default**: terminal/debug selections live as temporary `.log` files in the extension's global storage; trace logging is off by default;
- **Fail-safe self-lock**: failed summary refreshes auto-lock and pause, without repeatedly retrying and hurting the cache or the context window.

---

## 9. Who it's for

- **Pay-as-you-go DeepSeek users**: people who want their API bill down by an order of magnitude — KeepSeek is built for this;
- **Heavy agent users**: dozens of turns a day, endless long sessions — every turn saves money;
- **Engineers building projects with AI**: need a professional code-reading tool to keep the architectural rhythm and the full picture of changes;
- **Indie developers**: complete code reading, issue triage, and solution discussion in a lightweight sidebar;
- **Team engineers**: hand real code and real runtime output to the AI, cutting the back-and-forth of context copy-paste;
- **New team members / reviewers**: understand the structure fast; review precisely around files, line numbers, and logs.

---

## 10. Quick start (3 steps)

```bash
# 1. Build and install the VSIX
npm run package          # generates the VSIX
code --install-extension keepseek-<version>.vsix
```

```text
# 2. Open it in VS Code
KeepSeek: Open Agent Chat
```

```text
# 3. Open “Accounts and models” in KeepSeek settings, then create or select an account
# Legacy settings remain compatible: keepseek.apiKey / keepseek.baseUrl / DEEPSEEK_API_KEY
```

Then select some code, press `Cmd+L` / `Ctrl+L` (or right-click → KeepSeek: Add Selection to Chat), and ask your first question. Open the usage stats and compare the hit rates of turn 1 and turn 2 — those two numbers are the reason KeepSeek exists.

### Multiple accounts and model aliases

- The API settings dialog can create, rename, delete, and switch among multiple `deepseek` and `openai-compatible` accounts. Switching affects future requests only; existing sessions are neither rewritten nor bound to an account.
- Each account has its own API key, Base URL, model list, model aliases, and balance cache. The model switcher displays user alias → API-provided name → built-in label → model ID, while hover still reveals the full ID.
- DeepSeek accounts keep the complete Thinking and balance experience. OpenAI-compatible accounts provide chat, SSE streaming, and tool calls, without promising DeepSeek-specific reasoning, balance, or runtime parameters.
- A failed model refresh silently keeps the last cache and never blocks chat. If an OpenAI-compatible endpoint does not expose `/models`, add its model ID manually in settings.
- Account files live only in VS Code extension global storage, never in the workspace or Git: `<globalStorageUri>/accounts/<provider>/<accountId>.json`; balance data lives at `<globalStorageUri>/accounts/<provider>/<accountId>/balance.json`.
- Existing users need no manual migration. On the first upgrade with no account files, KeepSeek copies `keepseek.apiKey` / `keepseek.baseUrl` into `accounts/deepseek/default.json` without deleting or modifying the old settings, so downgrading remains safe.

---

## 11. Cost-related configuration cheat sheet

| Setting key | Default | Description |
|--------|--------|------|
| `keepseek.activeAccountId` | `""` | Globally active account; an empty value prefers the migrated `default` account |
| `keepseek.usagePricing` | DeepSeek default price list | Cache-hit / input / output prices per million tokens and currency, per model, used for cost estimation |
| `keepseek.balanceEndpointUrl` | `""` | Balance query endpoint; when empty, derived from `baseUrl` as `/user/balance` |
| `keepseek.balanceRefreshIntervalMs` | `60000` | Minimum interval for automatic balance refresh |
| `keepseek.slimToolModeEnabled` | `false` | **Off by default**: the full tool set keeps the tools section byte-stable for sustained cache hits; enabling it trades a smaller schema for a schema that varies with the prompt and lowers the hit rate |
| `keepseek.maxFileBytes` | `200000` | Max bytes read for a single reference/workspace file, controlling context size |
| `keepseek.maxWorkspaceToolFiles` | `2000` | Max candidate files enumerated by read-only listings and search |
| `keepseek.maxRequestRetries` | `2` | Automatic retries before the first response chunk (exponential backoff) |
| `keepseek.historyRetentionDays` | `7` | Default time range shown in the history menu (storage hard-cleans at 60 days) |

Model & Thinking-tier output budgets, tool-turn limits, and summary trigger/force ratios are fixed internal tiers; context compression is always on.

---

## 12. Acknowledgments: tribute to Reasonix

KeepSeek's cache-friendly mechanisms directly borrow from **Reasonix**'s proven approach to "accomplishing agent tasks with minimal tokens": byte-stable request prefixes, append-only history that only grows, low-frequency summary refreshes, and per-session frozen tool schemas. These ideas were validated in Reasonix's practice; KeepSeek builds on them with engineering and product work tailored to DeepSeek's prefix-cache billing.

Sincere **thanks** to Reasonix and its developers — every token and every cent KeepSeek saves includes your contribution.

---

## 13. Further reading

- **Cache-hit optimization deep dive (maintainers/advanced)**: [doc/cache.md](./doc/cache.md), [doc/cache_keepseek.md](./doc/cache_keepseek.md)
- **Agent runtime workflow**: [doc/keepseek-agent-runtime-workflow.md](./doc/keepseek-agent-runtime-workflow.md)
- **File reference spec**: [doc/keepseek-file-reference-spec.md](./doc/keepseek-file-reference-spec.md)
- **Source code**: [https://github.com/kmvdata/keepseek](https://github.com/kmvdata/keepseek)

---

*KeepSeek is open source (MIT License); source at [github.com/kmvdata/keepseek](https://github.com/kmvdata/keepseek). Cache-friendliness is not a slogan — it's an engineering contract in `agent/historyProjection.ts`, `agent/historyCompressor.ts`, and `agent/runner.ts`.*

*KeepSeek in one line: KeepSeek is a VS Code sidebar agent that treats context as a precise craft — it sends only the files, selections, and logs you choose, and keeps DeepSeek's prompt prefix cache hot across turns, with cached input costing as little as 1/50 (Flash) to 1/120 (Pro) of full price. It pairs Cursor-like native interactions with a professional read-only code navigation experience, so you stay in control of your architecture. Open source, MIT licensed.*
