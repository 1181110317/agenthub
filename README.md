# AgentHub

A local web workspace that brings multiple coding agents (Claude Code / Codex / ZCode / DeepSeek Harness / Gemini CLI / OpenCode / custom) into one UI, with an AgentHub-local ChatGPT-style chat mode.

## Features

- **Model center and Magpie** — search a unified model catalog with context, vision, reasoning and routing-group metadata. A running local Magpie gateway is discovered at `127.0.0.1:3425`; its models can be assigned to Claude, Codex, ZCode, the built-in Agent and chat. Save and apply named multi-Agent profiles, refresh provider catalogs, or switch the current idle task. Magpie retains its subscription credentials; a custom gateway key is encrypted locally.
- **Docked task browser** — browse beside chat, resize the desktop panel, take over input, select elements and view diagnostics. Closing the panel returns control to the Agent; task switches follow the selected session. The sidebar groups model/browser/toolbox navigation above a compact utility bar.
- **Multi-agent switch** — Claude Code / Codex / ZCode / DeepSeek Harness / Gemini CLI / OpenCode / built-in / custom, each with its own session list
- **DeepSeek Harness** — `dsh headless --json -` maps committed conversation, tool and usage events into the timeline; `--session-id` resumes turns. DSH keeps its own profile settings for model, provider and permissions. Its headless stream does not expose token deltas or AgentHub permission dialogs; dsh-TUI remains a separate terminal interface.
- **Chronological timeline** — commentary, thinking and tools keep their event order while streaming and after reload. Completed activity folds together, with the final answer visible. Tool-read images stay inside their tool step; other reply images use a bounded, collapsed collection. Interrupted text survives stopping and refreshing. Output rates require reliable request timing; sufficiently large historical replies can show a whole-turn average estimate marked ≈.
- **Diagram source** — Mermaid diagrams retain their exact source with separate diagram/source views, copying and theme-aware syntax colours. Invalid diagrams keep a readable source view; long code uses bounded highlighting without truncating the original.
- **Markdown and math** — local CommonMark parsing supports nested lists, task lists, escaped table pipes, reference links and footnotes. KaTeX recognises dollar and bracket delimiters, renders in bounded batches and preserves invalid formulas as readable source. Code and currency stay literal; Markdown file previews resolve images and source links relative to their own directory.
- **Consistent UI controls** — a local SVG vocabulary covers navigation, toolbars, menus, settings and tool cards. Matching usage chips, 36px header actions, readable sidebar labels and responsive menus keep the same visual rhythm; long titles truncate while preserving full labels and keyboard access.
- **Built-in agent** — no CLI install needed; auto-detects Anthropic / OpenAI-compatible endpoints; tools include file ops, shell, web search / fetch, one-click PPT/Word/Excel generation
- **Persistent native bridges** — Claude uses `--input-format stream-json`; ZCode uses `app-server`; Codex uses `app-server --stdio`; permissions / AskUserQuestion bridge to the web UI
- **Session fork / rewind / retry** — native where supported, bounded replay fallback otherwise
- **Provider & model management** — AgentHub-local CRUD (no cc-switch dependency at runtime); cc-switch is imported once on first launch for backward compatibility
- **Shared model routes** — API management → Agent model routes configures provider, model and reasoning defaults for Claude, Codex, ZCode, the built-in Agent and chat. An authenticated loopback gateway translates Messages, Responses and Chat, including tools, images and streaming. SSH/WSL can reach converted routes through target-side loopback forwarding. Windows networking follows an enabled system HTTP proxy when proxy environment variables are absent; internal loopback requests stay direct.
- **Token usage stats** — Today / Last N days / All time, daily charts and Agent/model/provider/session/project breakdowns; searchable records, CSV export and current-session metrics. Billing totals, latest request context, request counts, cache writes, TTFT and measured decode speed use separate fields. Missing prices and historical timing/count gaps stay visible.
- **Context window** — A compact window icon and progress bar open request usage and capacity settings. Recover measured context from request details or the session ledger, update received usage events immediately, and label an older measurement or missing historical data. Twelve presets include 1M, 1.024M, 2M and 4M; custom model capacities persist across reloads.
- **SSH / WSL remote** — SSH host manager, local WSL as first-class, remote session streaming, image preview over SSH. Sending shows startup/connection status immediately; startup failures preserve unconfirmed drafts and offer retry. SSH exec channel opening times out after 15 seconds, disconnects settle affected commands, and startup can be cancelled before the Agent is ready.
- **Command palette** — Ctrl+Shift+P opens everything: new task, switch theme / agent / panels
- **Conversation directory / computer resources** — Hover or open the right-side question outline to preview and jump through long conversations. The Resources button beside Running shows local CPU, RAM, supported NVIDIA GPU/VRAM and per-adapter network rates, plus backend RSS and estimated page JS heap; sampling runs only while the panel is visible and the owned collector retires after inactivity.
- **Themes** — 10 themes with IDs `paper`, `aionui`, `cottage`, `forest`, `ocean`, `sakura`, `ink`, `graphite`, `aurora`, `dusk`; preview cards and persistent custom theme import/export; terminal and diagram modes follow the selected palette
- **Workspace layout** — responsive navigation, aligned message/composer columns, and collapsible provider / permission / reasoning controls; choose a palette from the top-right theme button or Settings → Appearance

## Added in the seventh round

- **SQLite data layer** — sessions / messages / turn events / usage are mirrored into `data/agenthub.db` (built-in `node:sqlite`, no new dependency). JSON stays authoritative; the database is a rebuildable index. Backs in-session search (FTS5 for long queries, LIKE for 2-char CJK), usage aggregation in SQL, and per-session event history. `AGENTHUB_DB=0` disables it; `/api/db/rebuild` rebuilds it; the connection is closed when idle so the data directory can be moved or deleted while the server runs
- **In-session search (Ctrl+F)** — highlights every occurrence in the rendered conversation, cycles with Enter / Shift+Enter, expands collapsed process blocks, and shows the counter as a fraction; the hit set comes from the index so text inside collapsed steps is still found
- **Turn navigation rail** — one tick per user turn (plus tool-bearing assistant turns) along the right edge, highlights the turn you are reading, click to jump
- **On-demand resource monitor** — switch between the AgentHub computer and configured SSH hosts for CPU, available-memory usage, supported GPU/VRAM and per-interface network rates. SSH samples share a short cache and use a one-shot Node stdlib worker; no remote installation or resident service. Backend RSS and browser JS heap remain explicitly local. Unknown readings are never reported as zero.
- **Windows startup feedback** — `start-server.cmd` shows runtime checks, the service PID, HTTP readiness and live server errors while appending both output streams to the data directory's `logs/server.log`. It reports an occupied port without terminating the existing service; failed interactive launches stay visible. Set `AGENTHUB_NO_PAUSE=1` for unattended invocation.
- **Git changes preview** — searchable file list with actual staged/working/untracked line counts for local and SSH repositories, explicit binary/unavailable states, incremental rendering, and patch previews for modified, deleted, renamed and new files. Counts describe uncommitted work; commit history remains in the changes center.
- **Workspace file operations** — a Files tab in the right panel with a lazy tree, filename search, new file/folder, rename, move, delete (moved to `data/trash/`, not unlinked), copy path, reveal in Explorer, open with VS Code / terminal. Scoped to the session working directory, refuses `..`, symlink escapes, `.git`, and remote/WSL sessions
- **Built-in editor** — edit text/markdown/code in place with Ctrl+S, mtime conflict detection (asks before overwriting someone else's change), split-screen live Markdown preview with scroll sync, dirty markers, and a confirmation before closing an unsaved tab
- **Preview upgrades** — source files preview with highlighting instead of "unsupported", download / save-as, open with the system app, reveal in the file manager, and auto-refresh when an agent rewrites the file on disk
- **Third-party MCP servers** — add stdio or http servers, import from JSON, auto-detect what is already configured in `~/.claude.json` / `~/.codex/config.toml`, test the connection for real (spawns the process, lists tools), encrypt configuration and OAuth credentials at rest, and mask secrets in the UI. Built-in Agents call configured tools with permissions; ACP, Claude and Codex receive their native MCP configuration
- **Assistants and skills** — 12 built-in roles plus your own, with prompt and model / permission / reasoning defaults. Built-in, Claude and Codex receive native prompts; ACP and other CLIs receive explicit task context. Choose skills per session in Toolbox → Runtime; negotiated ACP models, modes, configuration and command catalogs appear there after initialization
- **Durable terminals** — reconnect or refresh to attach to the same running shell; one page controls input and viewers can explicitly take over. Unattached terminals expire after 30 minutes. Bounded disk history survives service restarts; the original process does not
- **Git and PR workflows** — Toolbox provides branches, fast-forward pull, fetch and stash. The GitHub PR workspace includes CI, diffs, local review drafts, inline reviews, comments, metadata and merge / draft / reopen actions with stale-head protection and persistent write receipts. Uses your existing `gh` account; other hosting providers remain gated
- **Task templates** — Toolbox includes review, testing, documentation and release checks, plus editable custom templates. Fill parameters, preview the complete prompt and append it to your draft or create a task draft using a saved project profile. Sending stays explicit; revisions protect edits from another page
- **Saved plans** — save or download a plan from its conversation card, find it later in Toolbox, and create an implementation draft using the source task's project and Agent configuration. Planning-only permission changes to editable mode; creation never sends a model request. Version checks protect edits, and saved text remains available after its source task is deleted
- **Scheduled tasks, deepened** — raw 5-field cron (with description and next-run preview), weekly / weekday / monthly patterns, execution mode "continue this conversation" vs "start a fresh session each run", per-run history (last 20), per-task notification toggle, and a desktop notification when a run finishes
- **Provider presets & health checks** — 17 platform presets (including local Ollama / LM Studio endpoints) prefill name, base URL, protocol and common models; a health check really calls the provider (`/models` without spending tokens, or a 1-token chat probe) and reports latency or a readable failure reason. Providers can be marked as accepting image input
- **WebUI accounts** — optional username/password access control: scrypt-hashed password, httpOnly session cookie, CSRF double-submit header on writes, per-IP login rate limit, password change (rotates the signing key so every other device must sign in again), and disable/ logout. Enabling requires loopback or `AGENTHUB_TOKEN`, and the environment token keeps working as the operator channel
- **Session list details** — unread dots (cleared when you open the conversation), multi-select with a bulk bar (archive / settle / pin / mark read / delete, each item reported individually), and pinned ordering you can move up or down; bulk archive cleans up message bodies and event files just like single archive
- **Agents can propose schedules** — the injected MCP server gained `scheduled_propose`, which only ever creates a *disabled* draft the user must enable, keeping the "no silent side effects" rule for injected tools
- **Cross-session mentions** — type `@@` in the composer to find another session and insert a clickable `@@[title](id)` reference; nested references are expanded server-side with cycle, depth, count and context-size guards
- **`/btw` side questions** — ask a one-off question in a floating panel using the current session's recent context; the answer is kept out of the main timeline and the endpoint is rate-limited
- **Project-scoped always-allow permissions** — an explicit “allow and remember” choice is scoped to the current project, Agent and tool; it never silently carries across projects, and can be listed or revoked through the permissions API

## Install & Run

Exports include encrypted SSH/MCP, speech, code-host, event and model-center records, while excluding their encryption keys (`.agenthub-ssh.key`, `.mcp-servers.key`, `.mcp-auth.key`, `.speech-input.key`, `.code-hosts.key`, `.event-triggers.key`, `.model-center.key`). Keep original keys separately when migrating credentials to another machine; unreadable ciphertext is preserved until its original key is restored.

Requires Node.js ≥ 22.19.0 (uses the built-in `node:sqlite`).

```bash
cd C:\agent\agenthub
npm install
npm start
```

Open http://127.0.0.1:7261 (loopback only).

On Windows, `start-server.cmd` runs the foreground service with startup diagnostics and console/log output. It uses its own directory, so it can also be launched from Explorer.

For LAN / phone access:

```bash
AGENTHUB_HOST=0.0.0.0 AGENTHUB_TOKEN=any-secret npm start
```

Then visit `http://<your-ip>:7261/?token=<secret>`.

For local agents (Claude / Codex / ZCode / DeepSeek Harness / Gemini / OpenCode) the matching CLI must be installed on the local machine or on the WSL / SSH target.

## Directory

```
agenthub/
├─ server.js              # Express + WebSocket server (API + chat/terminal bridges + image preview)
├─ lib/
│  ├─ agents.js           # Agent adapters (dsh/claude/codex/zcode/gemini/opencode/custom, local+WSL+remote)
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

`npm test` runs 95 registered scripts covering syntax, logic, API and browser regressions. Browser checks require a local Chrome or Edge installation and report a skip if neither is available. Tests use separate data directories; live provider credentials and real remote hosts are not required.

Run `node test/logic.js` and `node test/provider-gateway.js` for usage normalization, cache reads/writes, request accounting, Markdown and protocol conversion. `node test/updated-document-issues.js --api-only` covers HTTP/WS accounting without a browser.

Run `node test/remote-workspace-ssh.js` for target-side file operations, measured resources, Git line counts and immutable turn diffs through SSH in POSIX and Windows command forms. `npm run test:models` covers the model center, gateway protocols and docked browser; `npm run test:expansion` covers the toolbox and development workflows.

See [the change summary](CHANGELOG.md) for the implementation scope and limitations. Local troubleshooting reports, runtime captures and screenshots are kept out of the published repository. Vendored code attribution and licenses are documented in [third-party licenses](THIRD-PARTY-LICENSES.md).
