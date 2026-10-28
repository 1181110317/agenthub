# Troubleshooting

## The server refuses to start on `0.0.0.0`

```
AgentHub 拒绝在非本机地址监听：请先启用账户认证，或设置 AGENTHUB_TOKEN / AGENTHUB_RO_TOKEN。
```

This is intentional. Set `AGENTHUB_TOKEN` (or `AGENTHUB_RO_TOKEN`) or enable WebUI accounts while bound to loopback, then restart. See [Deployment → LAN / phone access](deployment.md#lan--phone-access).

## Port already in use

`start-server.cmd` reports an occupied port without killing the process that owns it. Either close the other AgentHub instance or start on another port:

```powershell
$env:AGENTHUB_PORT = '7262'
npm start
```

```bash
AGENTHUB_PORT=7262 npm start
```

## Node version / `node:sqlite` errors

AgentHub requires **Node.js ≥ 22.19.0**. Older versions lack the built-in `node:sqlite` module.

```bash
node --version
```

If you use a version manager, make sure the same Node binary is on `PATH` for the terminal that starts AgentHub.

## An agent CLI is not detected

1. Confirm the CLI works outside AgentHub:
   ```bash
   claude --version
   codex --version
   zcode --version
   dsh --version
   gemini --version
   opencode --version
   ```
2. If it works but AgentHub cannot find it, set its path in **Settings → Agents**.
3. For WSL or SSH sessions, install the CLI on the WSL distribution or target host — not only on the local machine.
4. A permission error on a CLI usually appears as “CLI path exists but failed to launch”; run the CLI manually as the same user to see the real error.

## Docked browser or screenshot tests are unavailable

The docked browser needs Chrome or Edge. AgentHub auto-detects common install paths. To choose a specific executable:

```powershell
$env:AGENTHUB_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm start
```

Browser tests report a skip if no browser is installed; that is not a failure of the rest of the test suite.

## `Host 不受信任` / 403 when using a domain

AgentHub rejects unauthenticated requests with an untrusted Host header to prevent DNS rebinding. Either:

- access through `http://127.0.0.1:7261` / `http://<IP>:7261`, or
- include a valid `?token=...`, or
- set `AGENTHUB_ALLOWED_HOSTS=agenthub.example.com` when using a reverse proxy, and include the public URL in `AGENTHUB_PUBLIC_URL` for MCP OAuth callbacks.

## 401 / 403 on a phone or another device

- Check that the URL includes `?token=<AGENTHUB_TOKEN>` on first visit.
- A read-only token (`AGENTHUB_RO_TOKEN`) can view but cannot send, approve or open terminals — use the full token for interactive access.
- If WebUI accounts are enabled, sign in again; changing the password invalidates all existing sessions.

## Live updates stop behind a reverse proxy

The browser needs a WebSocket upgrade. Nginx requires:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

Caddy handles this automatically. Also check that the proxy read timeout is longer than the longest expected idle period.

## `data` directory or encryption-key errors

- If an encrypted store reports `无法解密` or `加密密钥缺失`, restore the matching `.key` file from backup. The ciphertext cannot be recovered without its original key.
- Do not delete `.key` files while trying to “reset” a credential store; this permanently makes existing encrypted records unreadable.
- If a session body is corrupted, AgentHub creates a `.corrupt-*.json` backup and tries to rebuild from the event log. Keep the backup until you have verified the result.

## SQLite errors / database file locked

The SQLite index is rebuildable:

1. Stop the server.
2. Move or delete `data/agenthub.db` (and `-wal` / `-shm` files if present).
3. Start the server; the index rebuilds from JSON.

To disable the index entirely:

```powershell
$env:AGENTHUB_DB = '0'
npm start
```

## MCP OAuth redirect is wrong

Set `AGENTHUB_PUBLIC_URL` to the external URL users actually visit, for example:

```powershell
$env:AGENTHUB_PUBLIC_URL = 'https://agenthub.example.com'
```

The OAuth callback is built as `<public-url>/api/mcp/oauth/callback`.

## Session lists or usage look empty after moving data

Copy the whole `data/` directory, not just `sessions.json`. Session message bodies live in `data/sessions/<id>.json`; usage lives in `usage.json`; archived sessions live in `sessions-archive.jsonl`.

If you only copied the SQLite file, remember it is a derived index and cannot reconstruct data by itself. Copy JSON sources and let SQLite rebuild.

## Windows launcher closes immediately

- Run `start-server.cmd` from `cmd.exe` and read the printed error.
- Check `data/logs/server.log`.
- If the task scheduler launches it, set `AGENTHUB_NO_PAUSE=1` and make sure the working directory is the repository root.
- Verify `node --version` is at least 22.19.0.

## Getting more diagnostics

- In-app command palette → diagnostics panel: version, uptime, running turns, session/provider counts, event disk usage, cc-switch state and the last 120 log lines.
- `data/logs/server.log` for launcher/server output.
- Start with `AGENTHUB_ROUTE_LOG=<file>` to log API routes when diagnosing unexpected requests.

If the problem persists, include the server log tail, Node version, OS and the exact error message when reporting an issue.
