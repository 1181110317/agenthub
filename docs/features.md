# Feature reference

This page describes what AgentHub does and what each feature expects from the environment around it. For installation and access control, see [Deployment](deployment.md); for variables and agent setup, see [Configuration](configuration.md).

## Feature map

| Area | Includes |
| --- | --- |
| **Agents & sessions** | Native Claude/Codex/ZCode/DSH bridges, Gemini/OpenCode/custom adapters, ACP discovery, per-agent session lists, fork/rewind/retry, archive, WSL/SSH |
| **Chat experience** | Chronological timeline, collapsible activity, Markdown, KaTeX, Mermaid/WaveDrom, code blocks, search, turn rail, command palette, mentions, `/btw` |
| **Models & accounting** | Model Center, catalog metadata, Agent routes, Magpie, provider presets, usage dashboard, context meter, quotas |
| **Workspace & Git** | Files, built-in editor, previews, Git changes, checkpoints, PR workspace, durable terminals, resource monitor |
| **Automation & collaboration** | Assistants, skills, MCP servers, task queue, templates, saved plans, schedules, event triggers, handoff, subagents, shared browser |
| **Security & data** | Loopback default, shared/read-only tokens, WebUI accounts, CSRF, encrypted stores, SQLite index, backups |

## Agents & sessions

### Native and stream adapters

| Integration | Protocol | Notes |
| --- | --- | --- |
| **Claude Code** | `--input-format stream-json` persistent bridge | Native multi-turn continuation, permission prompts through `--permission-prompt-tool stdio`, AskUserQuestion in the web UI, native image blocks, resume after idle or restart |
| **Codex** | `app-server --stdio` | Native thread start/resume, command/file/permission approvals, user questions, `localImage` attachments, `codex update` fallback for older targets |
| **ZCode** | Official `app-server` | `session/create`, `session/resume`, `session/send`, `session/stop`; native interaction prompts and image attachments; `session/fork` where available |
| **DeepSeek Harness** | `dsh headless --json -` | Session, thinking, text, tool and usage events; `--session-id` continuation; DSH keeps its own model/provider/permission profile |
| **Gemini CLI** | Raw CLI stream adapter | Shell/stdin execution with JSON event parsing |
| **OpenCode** | Raw CLI stream adapter | Shell/stdin execution with JSON event parsing |
| **Built-in Agent** | Local engine | Anthropic Messages and OpenAI Chat-compatible endpoints, auto-detected by protocol |
| **Custom / ACP** | Command template or ACP discovery | Commands are user-configured; ACP entries are registered only when the CLI advertises an `acp` subcommand |

### Session behavior

- **Per-agent lists** — each agent has its own session list and highlights in the sidebar.
- **Capability chips** — streaming bridge, permission bridge, app-server, incremental events and tool support are shown only when the server actually detects them.
- **Per-session runtime** — provider, model, reasoning effort, permission mode, working directory and local/WSL/SSH host are saved on the session.
- **Fork, rewind and retry** — native where the CLI supports it; a bounded text replay is used only when native history is unavailable, with an explicit UI notice.
- **Session archive** — active sessions above the configured cap can be archived and restored from the command palette. Archived message bodies move to `data/sessions-archive.jsonl`.
- **Session list details** — unread dots, pinning and ordering, multi-select, bulk archive/settle/delete, and project-scoped defaults.
- **WSL and SSH** — local WSL is a first-class target; SSH hosts use the same agent adapters and receive target-side file/terminal operations.
- **Cross-session context** — `@@` mentions insert clickable references; nested references are expanded with cycle, depth, count and size guards.
- **Side questions** — `/btw` asks a one-off question using recent session context without adding the answer to the main timeline.
- **Project scopes** — “allow and remember” permissions are scoped to the current project, agent and tool and can be listed or revoked.

### Built-in agent tools

The built-in agent does not need a coding CLI. Depending on the provider configuration, its toolset includes:

- file reads, writes, directory listing and search
- shell command execution in the session workspace
- web search and page fetch
- one-click PowerPoint, Word and Excel generation
- MCP tools configured in AgentHub
- scheduling proposals that always create a disabled draft for the user to review

## Chat experience

### Timeline

- **True event order** — commentary, thinking, tool calls and final answers keep their chronological order during streaming and after reload.
- **Fold completed activity** — completed steps collapse into “worked for X · N steps”; click to expand the full process later.
- **Streaming state** — running steps show elapsed time, a subtle sweep animation and measured output rate where reliable request timing exists.
- **Interruption safety** — stopped or interrupted text survives refresh, and unconfirmed drafts remain in the composer after a failed send.
- **In-session search** — `Ctrl+F` searches rendered text, including text inside collapsed steps; Enter/Shift+Enter cycles matches.
- **Turn navigation rail** — one marker per user turn (and tool-bearing assistant turns) along the right edge; click to jump.
- **Conversation outline** — hover or open the right-side outline to preview and jump through long conversations.

### Rendering

- **CommonMark** — nested lists, task lists, escaped table pipes, reference links and footnotes.
- **Math** — KaTeX for dollar and bracket delimiters, bounded batch rendering and readable fallback for invalid formulas.
- **Diagrams** — Mermaid with separate diagram/source views, copying and theme-aware syntax colours; WaveDrom and WaveJSON source blocks.
- **Code** — syntax highlighting, exact copying, run buttons for shell/Python snippets and bounded highlighting for long files.
- **Images** — inline screenshots and generated images; tool-read images stay inside their tool step, reply images use a bounded collapsed collection.
- **File changes** — turn-level file chips with diff previews and undo where the file is still compatible.
- **Markdown files** — previews resolve images and links relative to the document directory.
- **Plan cards** — implementation plans can be saved or downloaded and turned into a draft without making a model request.

### Navigation and controls

- **Command palette** — `Ctrl+Shift+P` opens new task, theme switching, panel navigation and agent switching.
- **Theme system** — 10 built-in themes (`paper`, `aionui`, `cottage`, `forest`, `ocean`, `sakura`, `ink`, `graphite`, `aurora`, `dusk`), preview cards and custom theme import/export.
- **UI scaling** — 85%–130% zoom in Settings.
- **Responsive layout** — sidebar collapse and drawer navigation on narrow screens.
- **Consistent icons** — local SVG vocabulary for navigation, toolbars, menus and tool cards.
- **Speech input** — browser speech recognition in Chrome/Edge; optional provider speech settings.
- **Subagents** — delegated Task/Agent work is shown in a dedicated panel and linked back to its parent conversation.

## Models, providers & accounting

### Model Center

- **Unified catalogue** — aggregate models from every configured provider and a running Magpie gateway.
- **Capability metadata** — context length, image input, reasoning support, reasoning levels and routing groups.
- **Model actions** — assign a model to an agent, use it in the current idle task, search by name/provider/group and filter by capability.
- **Agent assignments** — set defaults for Claude, Codex, ZCode, the built-in agent and chat; saved profiles can be applied to new sessions.
- **Connections** — add, edit, refresh and remove API connections; keys remain masked after saving.
- **Magpie discovery** — auto-detects a local Magpie gateway at `http://127.0.0.1:3425/v1`; cached catalogue remains visible when Magpie is offline.

### Providers and routes

- **17 presets** — Anthropic, OpenAI, DeepSeek, OpenRouter, Z.ai, Moonshot, MiniMax, Groq, Together, local Ollama and LM Studio and more; preset fields prefill base URL, protocol and common models.
- **Provider management** — add/edit/delete locally; optional import from an existing cc-switch database on first launch.
- **Health checks** — call `/models` without spending tokens or run a 1-token chat probe; latency and readable failures are reported.
- **Balance and quota** — provider balance queries where supported, manual monthly/window limits, Codex official subscription windows, and `/usage-limits` snapshots.
- **Shared model routes** — per-agent provider/model/reasoning defaults.
- **Protocol gateway** — translates Anthropic Messages, OpenAI Responses and OpenAI Chat formats, including tools, images and streaming.
- **Remote routes** — SSH/WSL sessions can reach converted routes through target-side loopback forwarding.
- **Proxy-aware networking** — Windows uses the enabled system HTTP proxy when proxy environment variables are absent; internal loopback requests stay direct.

### Usage and context

- **Usage dashboard** — today / last N days / all time cards, daily charts, agent/model/provider/session/project breakdowns and CSV export.
- **Request details** — input, output, cache reads, cache writes, request count, TTFT, measured decode speed and cache-hit rate.
- **Missing data stays visible** — unknown prices and historical gaps are marked instead of replaced with zeroes.
- **Session usage** — per-turn amount, cumulative session totals and model distribution.
- **Context meter** — context usage and capacity settings; twelve presets from 1M to 4M tokens; custom capacities persist across reloads.
- **Cost controls** — custom model prices ($/1M tokens), manual monthly/window limits and provider quota badges.

## Workspace, Git & remote

### Files and editor

- **Workspace file tree** — lazy directory listing, filename search, new file/folder, rename, move and delete (moved to `data/trash/`, not unlinked).
- **File actions** — copy path, reveal in Explorer/File Manager, open with VS Code or a terminal.
- **Safety boundaries** — refuses `..`, symlink escapes and `.git`; local workspace only (not remote/WSL).
- **Built-in editor** — edit text, Markdown and code with `Ctrl+S`, mtime conflict checks, split-screen Markdown preview and dirty-tab protection.
- **Preview upgrades** — highlight source files, download/save-as, open with the system app, reveal in the file manager and auto-refresh when an agent rewrites a file.

### Git, PRs and history

- **Changes centre** — branch, ahead/behind, staged/working/untracked line counts, searchable file list and patch previews for modified/deleted/renamed/new files.
- **Checkpoints** — hidden-ref snapshots without commits on the user branch; view stats or restore the whole tree with a two-step confirmation.
- **Commit and PR flows** — stage-all commit, push and create PR; generated commit messages use staged diff, recent subject style and repository conventions.
- **GitHub PR workspace** — CI status, diffs, local review drafts, inline comments, metadata and merge/draft/reopen actions with stale-head protection and persistent write receipts.
- **Other code hosts** — GitHub Token, GitLab, Forgejo, Gitea, Bitbucket Cloud and Azure Repos API integrations with capability-aware actions.
- **Remote Git** — target-side diffs, staging, commit, pull and push through SSH.
- **Turn diffs** — immutable per-turn file changes with explicit unknown/binary states.

### Terminals and resources

- **Durable terminals** — server-managed shells survive refresh and reconnects; history is persisted to disk and the original process does not survive a server restart.
- **Single-writer control** — one page controls input; other viewers can watch or explicitly take over.
- **Retention** — unattached terminals expire after 30 minutes (configurable), with bounded disk history.
- **Local and SSH terminals** — current session’s local, WSL or SSH environment; new tabs and clear-screen controls.
- **Resource monitor** — local CPU, RAM, supported NVIDIA GPU/VRAM and per-interface network rates, with backend RSS and page JS heap explicitly labelled local.
- **SSH resource sampling** — one-shot Node worker on the target; no remote service required.

## Automation & collaboration

- **Assistants** — 12 built-in roles plus custom assistants with prompt, model, permission and reasoning defaults.
- **Skills** — per-session skill selection in Toolbox → Runtime; ACP models, modes and command catalogues appear after initialization.
- **MCP servers** — stdio and HTTP servers, JSON import, auto-detection from Claude/Codex configs, real connection tests, encrypted OAuth credentials and masked secrets.
- **Task queue** — queue, pause, resume, steer and stop turns; durable queue state.
- **Task templates** — review, testing, documentation and release checks plus editable custom templates with parameter previews and project profiles.
- **Saved plans** — save/download a plan and create an implementation draft with the original project and agent configuration.
- **Scheduled tasks** — raw 5-field cron, weekly/weekday/monthly patterns, one-shot schedules, continue-or-fresh execution, per-run history and notifications.
- **Event triggers** — event-driven tasks with filters, cooldown and delivery history.
- **Agent handoff** — preview context and continue a task with another agent.
- **Shared browser** — dock a browser panel, take over input, select elements, inspect diagnostics and release control back to the agent.
- **Subagents** — inspect delegated work and keep the parent conversation as the source of truth.

## Security & data

- **Local-first storage** — JSON is authoritative; SQLite is a rebuildable index. `AGENTHUB_DB=0` disables the SQLite mirror.
- **Encrypted stores** — SSH credentials, MCP configuration/OAuth tokens, speech settings, code-host tokens, event triggers and model-center configuration use AES-256-GCM with per-store keys. Provider API keys in `providers.json` are a plain JSON field; protect the data directory and do not publish that file.
- **Access control** — loopback by default; shared `AGENTHUB_TOKEN`, read-only `AGENTHUB_RO_TOKEN`, optional WebUI account login with scrypt password hashing.
- **Browser security** — httpOnly session cookies, CSRF double-submit headers for writes, per-IP login rate limits and signing-key rotation on password change.
- **Host checks** — DNS-rebinding protection for loopback access; explicit `AGENTHUB_ALLOWED_HOSTS` for reverse proxies.
- **Permission modes** — ask, accept-edits, plan and auto modes; remembered allowances are scoped to project + agent + tool.
- **Export and migration** — encrypted records export without their keys; missing keys preserve ciphertext rather than silently replacing it.
- **Rebuildable index** — deleting `data/agenthub.db` while the server is stopped is safe; JSON remains the source of truth.

## Known limits

- Agent-specific limitations are shown in the UI where relevant. For example, DSH headless does not expose token deltas or AgentHub permission dialogs; Claude, Codex and ZCode require compatible versions for native features.
- External provider accounts, real SSH hosts and third-party CLI edge cases are not exercised by the default test suite. See [Testing](testing.md).
- The docked browser requires a local Chrome or Edge installation and is not a full remote-browser service.
- AgentHub is Windows-first; the Node entry point may work on macOS/Linux, but the bundled launcher and some integrations are Windows-oriented.
- There is no built-in cloud sync, team workspace or mobile native app. Use LAN/VPN access or a reverse proxy for remote browsing.
