# Configuration

AgentHub is configured through environment variables at startup and through the web UI for per-installation settings.

## Environment variables

### Server and access

| Variable | Default | Description |
| --- | --- | --- |
| `AGENTHUB_PORT` | `7261` | HTTP and WebSocket port |
| `AGENTHUB_HOST` | `127.0.0.1` | Bind address. Non-loopback values require `AGENTHUB_TOKEN`, `AGENTHUB_RO_TOKEN` or enabled WebUI accounts |
| `AGENTHUB_TOKEN` | — | Shared access token. Accepted as `?token=`, `x-agenthub-token` header or stored by the browser |
| `AGENTHUB_RO_TOKEN` | — | Read-only token; GET/HEAD and live viewing only, writes return 403 |
| `AGENTHUB_ALLOWED_HOSTS` | — | Comma- or semicolon-separated Host header allowlist for domain/reverse-proxy access |
| `AGENTHUB_PUBLIC_URL` | request origin | Public base URL used for MCP OAuth callback URLs |

### Data and runtime

| Variable | Default | Description |
| --- | --- | --- |
| `AGENTHUB_DATA_DIR` | `<repo>/data` | Runtime data directory (sessions, usage, credentials, logs) |
| `AGENTHUB_WORKSPACE` | `~/AgentHub` | Default working directory for sessions without a project path |
| `AGENTHUB_DB` | on | Set to `0` to disable the SQLite mirror and use JSON-only paths |
| `AGENTHUB_DB_FILE` | `<data>/agenthub.db` | Override the SQLite index path |
| `AGENTHUB_BROWSER` | auto-detect | Chrome or Edge executable used by the docked browser |
| `AGENTHUB_MAX_ACTIVE_SESSIONS` | `500` | Cap before inactive sessions become eligible for archival |
| `AGENTHUB_TERMINAL_IDLE_MS` | `1800000` | Idle terminal retention in milliseconds (30 minutes) |
| `AGENTHUB_MAGPIE_URL` | `http://127.0.0.1:3425/v1` | Magpie gateway endpoint |
| `AGENTHUB_NO_PAUSE` | — | `1` stops `start-server.cmd` from pausing on exit |

### Agent and diagnostic overrides

These are intended for development, testing or unusual installations:

| Variable | Description |
| --- | --- |
| `AGENTHUB_CCSWITCH_DIR` | Override the cc-switch data directory used for the one-time import |
| `AGENTHUB_ZCODE_DIR` | Override the ZCode home used for usage scanning |
| `AGENTHUB_CODEX_USAGE_URL` | Override the Codex usage endpoint used by the balance provider |
| `AGENTHUB_IMPORT_DIRS` | Extra directories to scan for imported sessions (semicolon/comma separated) |
| `AGENTHUB_ROUTE_LOG` | Write a diagnostic log of `/api` routes to this file |
| `AGENTHUB_MCP_DISABLED` | Comma-separated injected MCP tool names to hide and disable |

PowerShell example:

```powershell
$env:AGENTHUB_DATA_DIR = 'D:\AgentHubData'
$env:AGENTHUB_PORT = '7261'
$env:AGENTHUB_TOKEN = 'change-me'
npm start
```

Bash example:

```bash
AGENTHUB_DATA_DIR=/srv/agenthub/data \
AGENTHUB_TOKEN='change-me' \
npm start
```

## Agent CLI setup

AgentHub detects binaries on `PATH`. If a CLI is installed elsewhere, set its path in **Settings → Agents**.

| Agent | Typical command | Notes |
| --- | --- | --- |
| Claude Code | `claude --version` | Native stream-json features require a compatible Claude Code version |
| Codex | `codex --version` | Uses `app-server --stdio`; older versions may fall back to `codex exec` |
| ZCode | `zcode --version` | Requires `app-server` support for native mode |
| DeepSeek Harness | `dsh --version` | Uses `dsh headless --json -`; DSH keeps its own profile |
| Gemini CLI | `gemini --version` | Raw CLI stream adapter |
| OpenCode | `opencode --version` | Raw CLI stream adapter |
| ACP agents | `qwen --help`, `codebuddy --help`, … | Registered only when the CLI advertises an `acp` subcommand |
| Custom | user-defined command | Configure arguments and prompt placement in Settings → Agents |

For WSL/SSH sessions, the CLI must be installed on the WSL distribution or remote target; the local machine only needs the SSH/WSL transport.

## Providers and models

Add providers in **Settings → API management**:

1. Choose a preset or “Custom”.
2. Enter the base URL and API key.
3. Fetch `/models` to discover the catalogue.
4. Set the protocol: `anthropic` for Messages-compatible endpoints, `openai` for Chat-completions-compatible endpoints.
5. Set a default model and reasoning strength if desired.

Provider records and API keys are stored in `data/providers.json`; this file is not encrypted by the dedicated secret stores, so protect the data directory. The UI masks keys after saving, and the server never returns the raw key through the providers API. A provider health check either calls `/models` (no token spend) or runs a 1-token chat probe.

The built-in agent can use any Anthropic or OpenAI-compatible provider. Claude, Codex, ZCode, Gemini, OpenCode and custom CLIs use the provider routing appropriate to their own protocol; see the [feature reference](features.md#models-providers--accounting).

## Data directory

The default layout is:

```text
data/
├─ sessions.json               # session index
├─ sessions/<id>.json          # per-session message bodies
├─ events/<id>.jsonl           # event streams for reload/reconnect
├─ usage.json                  # token and cost records
├─ providers.json              # provider catalogue
├─ settings.json               # UI and runtime settings
├─ agenthub.db                 # rebuildable SQLite index
├─ uploads/                    # images and attachments
├─ logs/                       # server logs
├─ sessions-archive.jsonl      # archived message bodies
└─ auth.json                   # optional WebUI account record
```

To move an installation, copy the whole data directory while the server is stopped. The SQLite file is optional; it can be rebuilt from JSON. Never copy encrypted credential files without their matching `.key` files.

## Security-related files

| File | What it protects |
| --- | --- |
| `.agenthub-ssh.key` | SSH host credentials |
| `.mcp-servers.key` | MCP server configuration and OAuth tokens |
| `.speech-input.key` | Speech provider settings |
| `.code-hosts.key` | Code-host API tokens |
| `.event-triggers.key` | Event trigger settings |
| `.model-center.key` | Magpie/model-center configuration |
| `auth.json` | WebUI account password hash and signing secret |

The key files live beside the data directory and use owner-only permissions where the platform supports it. Encryption protects copied files; it does not protect against another process running as the same OS user.

## Access control

- **Loopback only (default)** — safest for a single desktop.
- **Shared token** — set `AGENTHUB_TOKEN` before binding to `0.0.0.0`. The browser stores the token after the first `?token=` visit. Use a long random value.
- **Read-only token** — set `AGENTHUB_RO_TOKEN` for phones or observers. Read-only clients can view sessions and live output but cannot write.
- **WebUI accounts** — enable in **Settings → Access control** from the local machine. Passwords are scrypt-hashed; login cookies are httpOnly and SameSite=Lax; write requests require a matching CSRF header; login failures are rate-limited per IP. Changing the password rotates the signing key.

When AgentHub is behind a reverse proxy, set `AGENTHUB_ALLOWED_HOSTS` to the public hostname and keep `AGENTHUB_HOST=127.0.0.1`. Use HTTPS at the proxy.

## Desktop and browser settings

The in-app **Settings** panel stores non-secret preferences in `data/settings.json`:

- theme, UI scale and language
- sound and terminal shell
- agent paths and custom agents
- provider routes and recent models
- context-window presets
- permission memory and project defaults
- custom model pricing

The **Model Center** stores Magpie configuration in the encrypted `model-center.json` store. Provider connections remain in `providers.json` (see the security note above). Code-host tokens and preferences live in the encrypted `code-hosts.json` store. Credentials never appear in the general settings file.
