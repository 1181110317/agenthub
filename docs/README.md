# AgentHub documentation

[← Back to the project README](../README.md)

Start with the page that matches what you want to do.

| If you want to… | Read |
| --- | --- |
| Install AgentHub and open it for the first time | [Deployment → quick start](deployment.md#quick-start) |
| Access AgentHub from another device on my LAN or phone | [Deployment → LAN / phone access](deployment.md#lan--phone-access) |
| Put AgentHub behind Nginx, Caddy or a domain | [Deployment → reverse proxy](deployment.md#reverse-proxy-and-https) |
| Know every feature in detail | [Feature reference](features.md) |
| Set environment variables or configure an agent CLI | [Configuration](configuration.md) |
| Understand how the server and agents fit together | [Architecture](architecture.md) |
| Run or extend the tests | [Testing](testing.md) |
| Fix an error | [Troubleshooting](troubleshooting.md) |
| Read release notes | [CHANGELOG](../CHANGELOG.md) |
| Check third-party licences | [THIRD-PARTY-LICENSES](../THIRD-PARTY-LICENSES.md) |

## The 30-second orientation

```text
Browser (public/, vanilla SPA)
        │  HTTP + WebSocket
        ▼
AgentHub server (server.js, Node.js + Express + ws)
        ├─ agent adapters → local CLIs · WSL · SSH
        ├─ model gateway → Anthropic / OpenAI / Magpie / compatible APIs
        └─ workspace tools → files · editor · terminal · Git/PR · MCP
        │
        ▼
data/  JSON (authoritative) + SQLite (rebuildable index)
```

- **Default URL:** `http://127.0.0.1:7261`
- **Default bind:** loopback only
- **Runtime data:** `data/` (gitignored)
- **Required runtime:** Node.js ≥ 22.19.0

See [Architecture](architecture.md) for the full picture.
