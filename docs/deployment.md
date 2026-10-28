# Deployment

AgentHub is a Node.js server with a static front end. There is no build step and no external database service to install.

## Quick start

### Requirements

| Requirement | Notes |
| --- | --- |
| **Node.js ≥ 22.19.0** | Required; the server uses the built-in `node:sqlite` |
| **npm** | Installed with Node.js |
| **Windows 10/11** | Primary target; the bundled launcher uses Windows conventions |
| **Chrome or Edge** | Optional, for the docked browser and browser regression tests |
| **Agent CLIs** | Optional; install the CLIs you want to use, or use the built-in agent |

Agent CLIs must be on `PATH` (or configured in Settings → Agents) for Claude Code, Codex, ZCode, DeepSeek Harness, Gemini CLI and OpenCode. The built-in agent needs no CLI — only an Anthropic or OpenAI-compatible provider.

### Install and run

```bash
git clone https://github.com/1181110317/agenthub.git
cd agenthub
npm install
npm start
```

Open **http://127.0.0.1:7261**.

The default bind address is `127.0.0.1`, so the first launch is not reachable from other machines. Keep it that way unless you need remote access and have read [Access control](#access-control).

### Windows launcher

Double-click **`start-server.cmd`** to start the server with:

- Node.js and port checks before launch
- the service PID and HTTP readiness in the console
- live server errors
- output appended to `data/logs/server.log`

Set `AGENTHUB_NO_PAUSE=1` when launching from a scheduler or another unattended process.

### First-run setup

1. Open **Settings → API management** and add a provider, or point AgentHub at a running Magpie gateway.
2. Pick an agent in the sidebar (Built-in Agent is a good first test).
3. Choose a project directory in the composer.
4. Send a short prompt. Agent CLIs must be installed and discoverable for the non-built-in agents.

## LAN / phone access

Binding to all interfaces requires an access token. AgentHub refuses to start on a non-loopback address when no token or account authentication is configured.

### Bash / macOS / Linux

```bash
AGENTHUB_HOST=0.0.0.0 \
AGENTHUB_TOKEN='choose-a-long-random-secret' \
AGENTHUB_PORT=7261 \
npm start
```

### PowerShell

```powershell
$env:AGENTHUB_HOST = '0.0.0.0'
$env:AGENTHUB_TOKEN = 'choose-a-long-random-secret'
$env:AGENTHUB_PORT = '7261'
npm start
```

Open `http://<your-computer-ip>:7261/?token=choose-a-long-random-secret` on the phone or another computer. The token is remembered by the browser after the first visit.

Notes:

- Allow TCP port `7261` through the Windows firewall if the phone cannot connect.
- Use a **read-only token** (`AGENTHUB_RO_TOKEN`) on devices that only need to watch progress. Read-only clients cannot send messages, approve permissions, open terminals or change settings.
- Prefer a private LAN or VPN. Do not expose a plain-HTTP port to the public internet.
- If the page loads but API calls fail with `Host 不受信任`, set `AGENTHUB_ALLOWED_HOSTS` (see below).

## Reverse proxy and HTTPS

For a domain such as `agenthub.example.com`, keep AgentHub on loopback and let a reverse proxy terminate TLS.

Set:

```bash
AGENTHUB_HOST=127.0.0.1
AGENTHUB_PORT=7261
AGENTHUB_TOKEN='choose-a-long-random-secret'
AGENTHUB_ALLOWED_HOSTS=agenthub.example.com
AGENTHUB_PUBLIC_URL=https://agenthub.example.com
```

`AGENTHUB_PUBLIC_URL` is used to build the OAuth callback URL for MCP servers. `AGENTHUB_ALLOWED_HOSTS` accepts comma- or semicolon-separated Host names.

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name agenthub.example.com;

    ssl_certificate     /etc/letsencrypt/live/agenthub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agenthub.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7261;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

The `Upgrade` and `Connection` headers are required for the WebSocket timeline and live terminal streams.

### Caddy

```caddyfile
agenthub.example.com {
    reverse_proxy 127.0.0.1:7261
}
```

Caddy handles TLS and WebSocket upgrades automatically.

## Access control

AgentHub has three access layers:

| Layer | How it works | Best for |
| --- | --- | --- |
| **Loopback trust** | Requests from `127.0.0.1` are trusted; Host must be an IP literal, `localhost` or an allowed host | Desktop use |
| **Shared token** | `AGENTHUB_TOKEN` in the URL, `x-agenthub-token` header, or browser storage after first visit | LAN, phone, simple reverse proxy |
| **WebUI accounts** | Username/password login with httpOnly session cookie + CSRF header | People who prefer a login page over a shared link |

Enable **Settings → Access control** from the local machine to create a WebUI account. Password changes rotate the signing key, so other devices must sign in again. Login attempts are rate-limited per IP. The shared `AGENTHUB_TOKEN` remains an operator channel when account login is enabled.

Security checklist for an internet-facing deployment:

- Terminate TLS at the reverse proxy and use a strong, unique `AGENTHUB_TOKEN`.
- Restrict access with a VPN, firewall allowlist or identity-aware proxy where possible.
- Do not expose the server on a public address without authentication.
- Back up `data/` and the encryption key files before changing authentication settings.
- Review [Configuration](configuration.md#security-related-files) for the encrypted stores and their keys.

## Data directory and backups

By default, runtime data lives in `data/` next to `server.js`. Move it with `AGENTHUB_DATA_DIR`:

```bash
AGENTHUB_DATA_DIR=/var/lib/agenthub npm start
```

PowerShell:

```powershell
$env:AGENTHUB_DATA_DIR = 'D:\AgentHubData'
npm start
```

Important contents:

```text
data/
├─ sessions.json             # session index
├─ sessions/<id>.json        # message bodies
├─ events/<id>.jsonl         # resumable event streams
├─ usage.json                # token and cost records
├─ providers.json            # provider catalogue
├─ settings.json             # UI / runtime settings
├─ agenthub.db               # rebuildable SQLite index
├─ uploads/                  # images and attachments
├─ logs/                     # server and launcher logs
├─ .agenthub-ssh.key         # encryption keys for stored credentials
├─ .mcp-servers.key
├─ .speech-input.key
├─ .code-hosts.key
├─ .event-triggers.key
└─ .model-center.key
```

Back up the whole directory while the server is stopped — or at least while it is idle — so JSON writes and the SQLite mirror are consistent.

```bash
tar -czf agenthub-data-$(date +%F).tar.gz data/
```

```powershell
Compress-Archive -Path .\data -DestinationPath "agenthub-data-$(Get-Date -Format yyyy-MM-dd).zip"
```

Keep the `.key` files with the data directory. Encrypted credential files are not recoverable without their original keys; copying only the JSON ciphertext will not migrate SSH/MCP/provider secrets.

## Upgrades

```bash
# stop the server first
git pull --ff-only
npm install
npm start
```

Back up `data/` before upgrading. The SQLite index is a derived cache and can be rebuilt from JSON; deleting `data/agenthub.db` is safe while the server is stopped. Keep `sessions.json`, `sessions/`, `events/`, `usage.json` and the key files.

## Service examples

### Windows Task Scheduler

1. Create a task triggered at startup or user logon.
2. Action: **Start a program** → `C:\agent\agenthub\start-server.cmd`.
3. Start in: `C:\agent\agenthub`.
4. Prefer a dedicated Windows account with access to the project and data directory.

### systemd (Linux)

If your environment uses systemd, this is a minimal unit. Adjust `ExecStart` if Node is installed elsewhere (for example under a version manager):

```ini
[Unit]
Description=AgentHub
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/agenthub
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=agenthub
Environment=AGENTHUB_HOST=127.0.0.1
Environment=AGENTHUB_PORT=7261
Environment=AGENTHUB_DATA_DIR=/var/lib/agenthub
# Environment=AGENTHUB_TOKEN=change-me

[Install]
WantedBy=multi-user.target
```

Run `npm install` as the service user first, then `systemctl enable --now agenthub`.

## Uninstall

1. Stop the server.
2. Remove the project directory.
3. Remove the data directory you configured (`data/` by default or `AGENTHUB_DATA_DIR`).
4. Remove any reverse-proxy, firewall or service entries you added.

There is no system-wide installer or registry footprint.
