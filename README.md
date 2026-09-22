# AgentHub

A local web workspace that brings multiple coding agents (Claude Code / Codex / ZCode / Gemini CLI / OpenCode / custom) into one UI, with an AgentHub-local ChatGPT-style chat mode.

## Features

- **Multi-agent switch** — Claude Code / Codex / ZCode / Gemini CLI / OpenCode / built-in / custom, each with its own session list
- **Harness-style timeline** — each turn renders as process steps (thinking / tool calls / intermediate output) plus the final answer; running steps have a shimmer animation and "working · Ns · tok/s" header
- **Built-in agent** — no CLI install needed; auto-detects Anthropic / OpenAI-compatible endpoints; tools include file ops, shell, web search / fetch, one-click PPT/Word/Excel generation
- **Persistent native bridges** — Claude uses `--input-format stream-json`; ZCode uses `app-server`; Codex uses `app-server --stdio`; permissions / AskUserQuestion bridge to the web UI
- **Session fork / rewind / retry** — native where supported, bounded replay fallback otherwise
- **Provider & model management** — AgentHub-local CRUD (no cc-switch dependency at runtime); cc-switch is imported once on first launch for backward compatibility
- **Token usage stats** — Today / Last N days / All time cards, daily stacked bars, model/agent breakdowns
- **SSH / WSL remote** — SSH host manager, local WSL as first-class, remote session streaming, image preview over SSH
- **Command palette** — Ctrl+Shift+P opens everything: new task, switch theme / agent / panels
- **Themes** — 10 palettes (Paper / Cloud / Warm Sun / Forest / Sea Salt / Sakura / Ink / Graphite / Aurora / Dusk), preview cards and persistent custom theme import/export; terminal and diagram modes follow the selected palette
- **Workspace layout** — responsive navigation, aligned message/composer columns, and collapsible provider / permission / reasoning controls; choose a palette from the top-right theme button or Settings → Appearance

## Added in the seventh round

- **SQLite data layer** — sessions / messages / turn events / usage are mirrored into `data/agenthub.db` (built-in `node:sqlite`, no new dependency). JSON stays authoritative; the database is a rebuildable index. Backs in-session search (FTS5 for long queries, LIKE for 2-char CJK), usage aggregation in SQL, and per-session event history. `AGENTHUB_DB=0` disables it; `/api/db/rebuild` rebuilds it; the connection is closed when idle so the data directory can be moved or deleted while the server runs
- **In-session search (Ctrl+F)** — highlights every occurrence in the rendered conversation, cycles with Enter / Shift+Enter, expands collapsed process blocks, and shows the counter as a fraction; the hit set comes from the index so text inside collapsed steps is still found
- **Turn navigation rail** — one tick per user turn (plus tool-bearing assistant turns) along the right edge, highlights the turn you are reading, click to jump
- **Workspace file operations** — a Files tab in the right panel with a lazy tree, filename search, new file/folder, rename, move, delete (moved to `data/trash/`, not unlinked), copy path, reveal in Explorer, open with VS Code / terminal. Scoped to the session working directory, refuses `..`, symlink escapes, `.git`, and remote/WSL sessions
- **Built-in editor** — edit text/markdown/code in place with Ctrl+S, mtime conflict detection (asks before overwriting someone else's change), split-screen live Markdown preview with scroll sync, dirty markers, and a confirmation before closing an unsaved tab
- **Preview upgrades** — source files preview with highlighting instead of "unsupported", download / save-as, open with the system app, reveal in the file manager, and auto-refresh when an agent rewrites the file on disk
- **Third-party MCP servers** — add stdio or http servers, import from JSON, auto-detect what is already configured in `~/.claude.json` / `~/.codex/config.toml`, test the connection for real (spawns the process, lists tools), secrets are masked at rest and preserved on save, inject into Claude (`--mcp-config`) and Codex (`-c` overrides) per agent
- **Assistants** — 12 built-in roles (code review, fix tests, release check, docs, refactor, perf, security, PPT/Word/Excel, research, commit messages) plus your own; each carries a system prompt and default model / permission / reasoning. The prompt reaches the built-in agent as `system` and Claude as `--append-system-prompt`; agents without an equivalent hook only inherit the defaults and the UI says so instead of pretending
- **Scheduled tasks, deepened** — raw 5-field cron (with description and next-run preview), weekly / weekday / monthly patterns, execution mode "continue this conversation" vs "start a fresh session each run", per-run history (last 20), per-task notification toggle, and a desktop notification when a run finishes
- **Provider presets & health checks** — 17 platform presets (including local Ollama / LM Studio endpoints) prefill name, base URL, protocol and common models; a health check really calls the provider (`/models` without spending tokens, or a 1-token chat probe) and reports latency or a readable failure reason. Providers can be marked as accepting image input
- **WebUI accounts** — optional username/password access control: scrypt-hashed password, httpOnly session cookie, CSRF double-submit header on writes, per-IP login rate limit, password change (rotates the signing key so every other device must sign in again), and disable/ logout. Enabling requires loopback or `AGENTHUB_TOKEN`, and the environment token keeps working as the operator channel
- **Session list details** — unread dots (cleared when you open the conversation), multi-select with a bulk bar (archive / settle / pin / mark read / delete, each item reported individually), and pinned ordering you can move up or down; bulk archive cleans up message bodies and event files just like single archive
- **Agents can propose schedules** — the injected MCP server gained `scheduled_propose`, which only ever creates a *disabled* draft the user must enable, keeping the "no silent side effects" rule for injected tools
- **Cross-session mentions** — type `@@` in the composer to find another session and insert a clickable `@@[title](id)` reference; nested references are expanded server-side with cycle, depth, count and context-size guards
- **`/btw` side questions** — ask a one-off question in a floating panel using the current session's recent context; the answer is kept out of the main timeline and the endpoint is rate-limited
- **Project-scoped always-allow permissions** — an explicit “allow and remember” choice is scoped to the current project, Agent and tool; it never silently carries across projects, and can be listed or revoked through the permissions API

## Install & Run

Requires Node.js ≥ 22.5 (uses the built-in `node:sqlite`).

```bash
cd C:\agent\agenthub
npm install
npm start
```

Open http://127.0.0.1:7261 (loopback only).

For LAN / phone access:

```bash
AGENTHUB_HOST=0.0.0.0 AGENTHUB_TOKEN=any-secret npm start
```

Then visit `http://<your-ip>:7261/?token=<secret>`.

For local agents (Claude / Codex / ZCode / Gemini / OpenCode) the matching CLI must be installed on the local machine or on the WSL / SSH target.

## Directory

```
agenthub/
├─ server.js              # Express + WebSocket server (API + chat/terminal bridges + image preview)
├─ lib/
│  ├─ agents.js           # Agent adapters (claude/codex/zcode/gemini/opencode/custom, local+WSL+remote)
│  ├─ api-agent.js        # Built-in agent engine (Anthropic + OpenAI-compatible)
│  ├─ claude-bridge.js    # Claude Code native stream-json bridge
│  ├─ codex-bridge.js     # Codex app-server stdio bridge
│  ├─ zcode-bridge.js     # ZCode app-server bridge
│  ├─ acp-agent.js        # ACP preset integration
│  ├─ ccswitch.js         # cc-switch SQLite read-only (one-time import for back-compat)
│  ├─ balance.js          # Balance queries + model catalog fetch
│  ├─ usage.js            # Usage records + local history scan + aggregation
│  ├─ ssh.js              # ssh2 pool / exec / shell
│  ├─ store.js            # JSON persistence
│  ├─ events.js           # Internal event bus
│  ├─ page-security.js    # Page-level security checks
│  ├─ permission-policy.js# Per-session permission policy
│  ├─ session-policy.js   # Session archive / lifecycle policy
│  ├─ native-runtime.js   # Native binary resolution
│  ├─ nativesessions.js   # Native session metadata
│  └─ claude-parser.js    # Claude stream-json parser
├─ public/                # Frontend SPA (vanilla HTML/CSS/JS + echarts + xterm + mermaid)
├─ vendor/
│  └─ image-size-safe/    # Patched image-size that handles malformed inputs safely
├─ test/                  # Syntax, logic, isolated API and browser regression tests
└─ data/                  # Runtime data (sessions / usage / ssh / model-cache / providers) — gitignored
```

## Validation

`npm test` runs the syntax, logic, API and browser regression suite. Browser checks require a local Chrome or Edge installation and report a skip if neither is available. Tests use separate data directories; live provider credentials and real remote hosts are not required.

Run `node test/workspace-ui.js` for theme persistence, contrast, composer controls, single-day usage charts and asynchronous form regression checks. See [the UI and functional audit](TEST-AUDIT-2026-09-20.md) for the verified scope.

`node test/settings-ui.js` covers cross-Agent navigation, custom Agent CRUD, partial settings updates, queue choices, context after compaction, concurrent MCP settings and authentication form visibility. The [second audit](TEST-AUDIT-2026-09-20-ROUND2.md) records the reproduced failures and fixes. [Possible next features](FEATURES-NEXT.md) are proposals, not implemented capabilities.

The [2026-09-21 logic audit](TEST-AUDIT-2026-09-21.md) adds regression coverage for recovery, command receipts, streaming failures, Git snapshots, SSH persistence, quota races and native session import/fork. Restoring a backup pauses writes until AgentHub restarts, protecting the restored files from the previous in-memory state.
