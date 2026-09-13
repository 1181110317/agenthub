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
- **Themes** — 7 themes (AionUi Light / Aurora / Sakura / Ink Night / Paper White / Warm Sun / Forest Eye-care); xterm + mermaid palettes follow

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
├─ test/                  # Logic / syntax / reasoning-smoke tests
└─ data/                  # Runtime data (sessions / usage / ssh / model-cache / providers) — gitignored
```