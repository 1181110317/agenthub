# AgentHub · Aggregated Agent Workspace

A local web UI that brings multiple coding agents (Claude Code / Codex / ZCode / Gemini CLI / OpenCode / custom) into a single interface, with an AgentHub-local ChatGPT-style chat mode.

> **Built-in Agent (no CLI required)**: Inspired by AionUi's zero-config approach — install nothing, pick a built-in agent + provider + model and start chatting. The engine talks directly to the Anthropic / OpenAI-compatible protocol (auto-detected) and ships with the full toolset: read/write files, list directories, run commands, web search / web fetch, **one-click PPT / Word / Excel generation**.
> **Scheduled Tasks**: The sidebar's "Schedule" panel creates every-N-minutes or daily-time jobs that automatically send a prompt to a chosen session at the trigger time (skipped if the session is busy).
> **Command Palette**: Press Ctrl+Shift+P — new task, switch theme, open panels, switch agent — all keyboard-accessible.
> **Session Fork**: One-click fork any message into a new session with full config copied; native sessions prefer the agent's native fork and fall back to bounded replay for legacy/remote.
> **UI Zoom**: 85%–130% in Settings; narrow screens (mobile / half-window) auto-collapse the sidebar into a drawer.
> **普通聊天**: The "普通聊天" mode uses the selected AgentHub API provider in a ChatGPT-style conversation UI. It sends no tool definitions and never runs CLI, file, shell, browser, or other Agent tools.

UI uses a harness-style timeline (à la deepseek-harness) and an architecture inspired by AionUi (REST + WS driving an agent core). Zero build, vanilla web.

## Run

```bash
cd C:\agent\agenthub
npm start        # or: node server.js
```

Open http://127.0.0.1:7261 (loopback only)

**LAN / phone access** (optional): set env then restart
```bash
AGENTHUB_HOST=0.0.0.0 AGENTHUB_TOKEN=any-secret npm start
```
From phone/another PC visit `http://<your-ip>:7261/?token=<secret>`. Token is remembered.

## Features

### 1. Multi-agent switch + harness timeline
- Sidebar agent cards to switch between Claude Code / Codex / ZCode / Gemini CLI / OpenCode / 普通聊天, each with its own session list
- **Timeline rendering (deepseek-harness style)**: each turn = process-step rows (thinking / tool call / intermediate output with own duration + status icon) + final answer area; running steps get a shimmer animation, header shows "working · Ns · tok/s"; after completion, collapses to "worked Xm Xs · N steps" with click-to-expand
- Claude uses a **persistent bidirectional stream-json bridge** (native SDK protocol via `--input-format stream-json`): multi-turn in same process, permission prompts bridged to web via `--permission-prompt-tool stdio` (allow/deny really take effect), AskUserQuestion answered on web, images enter context as native content blocks; idle recycling + auto `--resume` on restart
- ZCode locally uses official `app-server` (`session/create|resume|send|stop`) native bidirectional protocol, multi-turn reuses one process; permissions / AskUserQuestion bridged from official interaction requests; images use native attachments; internal headless Browser Use stays in ZCode. WSL/SSH auto-probe `app-server` on the target, run it through persistent WSL/SSH stdin channel; fall back to the official CLI entrypoint only when unsupported. No built-in self-update command — fill `remoteBin` / `upgradeCommand` for the target in Settings.
- Codex locally uses official `app-server --stdio` (`thread/start|resume`, `turn/start|interrupt`) native bidirectional protocol, multi-turn reuses one thread; official commands / files / permission approvals / user questions bridged to web; images use `localImage` native attachments. WSL/SSH run `app-server --stdio` through the target's persistent stdin channel; if a legacy CLI is detected, the target's `codex update` is invoked first; only on failure do we fall back to `codex exec` / `exec resume`.
- Claude on WSL/SSH also probes `--input-format`; if incompatible, the target's `claude update` is invoked first; on success, the persistent stream-json bridge continues.
- **Rewind / retry / fork via native**: Claude/Codex truncate-copy the agent's own session history under a new session id and continue; ZCode locally uses official `session/fork`. Bounded text replay is only used as a last-resort fallback for legacy CLIs, remote protocols that don't support it, or when native file surgery fails, with an explicit in-UI notice.
- **Session archive**: active sessions past the cap auto-archive idle non-running sessions; recoverable from the command palette; archive failures never delete live data.
- Agents with no CLI detected can be pointed to a custom path in Settings; custom agents (raw text streaming) can also be added.
- Per-session config: provider, model, working directory (locked after first message), auto-permission, reasoning effort (Claude via `--settings` env, Codex via `-c model_reasoning_effort`), remote host.
- File-change chips (diff view / revert), execution plan, inline images, mermaid rendering, web chip (embedded browser drawer).

### 1.5 Per-session usage
- Header "Σ session usage": per-turn input/output/cache/total + grand total + model breakdown + context occupancy (computed from the last API call).
- Pills at the end of each reply: duration / output / input / actual model.

### 2. API / model management (AgentHub-local)
- API entries are stored and managed by AgentHub in `data/providers.json`; keys are masked in the UI and CRUD/model lookup work without cc-switch.
- On first startup, an available cc-switch SQLite database can be imported once for backward compatibility. Imported entries become editable AgentHub-local records; cc-switch is not queried on every page load or chat turn.
- Cached `/v1/models` catalogs live in `data/model-cache.json`; the model's picker groups by "provider catalog / generic candidates".
- Codex providers inject `config.toml` + `auth.json` via per-session `CODEX_HOME`; remote sessions also map the config to remote `~/.agenthub-codex/`.
- Claude providers inject `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` + per-session `--settings` override; ZCode providers inject process-level `ZCODE_MODEL` / `ZCODE_BASE_URL` / `ZCODE_API_KEY` (switching always takes effect). ZCode currently adapts the Anthropic Messages channel; BigModel / Z.ai Coding Plan's OpenAI endpoint auto-switches to the official Anthropic endpoint; OpenAI endpoints on ordinary packs / prepaid balances are incompatible — the UI explicitly prompts you to use the built-in agent's OpenAI channel or configure an Anthropic-compatible URL.
- Add, edit and delete providers locally; balance queries (DeepSeek / OpenRouter / one-api family auto-detected).

### 3. Token usage stats
- Real-time on-disk + cc-switch aggregation + local history scan (`~/.claude` / `~/.codex` / `~/.zcode`).
- Stats page top row: **Today / Last N days / All time** cards + input/output/cache/cost; daily stacked bar, model/agent donuts, detail table.

### 4. SSH / WSL remote
- SSH host manager (password / private key / agent auth; only stored locally), remote session stream back, 🖥 badge.
- Local WSL as first-class: 🐧 dedicated group, WSL sessions, WSL terminal, all async so the service never blocks.
- Remote-generated images previewable in one click (SSH base64 back-channel).

### 5. Themes
- 🎨 menu switches 7 themes: **AionUi Light / Aurora / Sakura / Ink Night / Paper White / Warm Sun / Forest Eye-care**; xterm + mermaid palettes follow; preference remembered locally.

## Layout

```
agenthub/
├─ server.js          # Express + WebSocket server (API + chat/terminal WS bridges + image preview + model cache)
├─ lib/
│  ├─ agents.js       # Agent adapters (claude/codex/zcode/gemini/opencode/custom, local + WSL + remote)
│  ├─ ccswitch.js     # cc-switch SQLite read-only (providers / usage_rollups / pricing / error pass-through)
│  ├─ balance.js      # Balance queries + model lists
│  ├─ usage.js        # Usage records / local scan / aggregation
│  ├─ ssh.js          # ssh2 pool / exec / shell
│  └─ store.js        # JSON persistence
├─ public/            # Frontend (vanilla-JS SPA + harness timeline + echarts + xterm + mermaid)
└─ data/              # Runtime data (sessions/usage/ssh/model-cache/settings/providers)
```

## Notes

- Requires a current Node.js runtime. Node ≥ 22.5 enables the optional one-time cc-switch import; API management and built-in Agent do not require cc-switch. Local or WSL/SSH target must have the corresponding claude / codex / zcode CLI installed; remote native bridges check and upgrade on first connect per config.
- cc-switch remains an optional read-only compatibility source for one-time migration and historical usage/pricing statistics; its availability does not affect the AgentHub-local API list.
- "Set as default provider" (★) only affects new sessions in this app; it does not modify cc-switch / global CLI config.
- Known issues and fix history: see [BUGS.zh.md](./BUGS.zh.md) (Chinese; kept locally only — not in this repo).
