# Testing

AgentHub’s test suite is a set of Node.js scripts rather than a single test runner. `npm test` runs all 95 registered scripts in sequence.

## Run the full suite

```bash
npm test
```

The suite covers:

- syntax and static front-end checks
- document/fact consistency checks
- usage normalization, pricing and cache accounting
- Markdown, protocol and provider-gateway conversion
- session persistence, archive, restore and migration
- isolated HTTP/WebSocket API tests
- browser UI checks where Chrome or Edge is available
- SSH/WSL file operations and remote workspace behavior
- MCP, Git, terminal durability, scheduling and event flows
- concurrency, fuzz and soak checks

Browser checks create their own headless Chrome/Edge profile and data directory. If neither browser is installed they report a skip rather than failing the suite.

## Focused commands

| Command | What it exercises |
| --- | --- |
| `node test/logic.js` | Usage normalization, cache accounting, Markdown and protocol conversion |
| `node test/provider-gateway.js` | Messages / Responses / Chat conversion |
| `node test/remote-workspace-ssh.js` | SSH file operations, resource metrics, Git counts and immutable turn diffs |
| `npm run test:models` | Model center, gateway protocols and docked browser |
| `npm run test:expansion` | Toolbox, target workspace and development workflows |
| `npm run test:workflows` | Features runtime, MCP OAuth, durable terminals, Git workflows, templates |
| `npm run test:issues` | Provider gateway, stop/recovery, remote workspace, SFTP and document issues |
| `npm run test:updated-issues` | Updated document/issue regression suite |

## Isolation

The API and browser tests use temporary data directories and temporary workspaces. They do not read or modify the production `data/` directory. The default suite does not require:

- live provider API keys
- a real SSH host
- a live Magpie gateway
- every third-party agent CLI

Tests that touch real remote hosts or provider accounts are kept as manual/opt-in checks.

## Adding tests

The repository’s `doc-lint` check verifies that every `test/*.js` file is registered in `package.json`’s `test` chain and that the documented script count matches. If you add a test file, add it to `npm test` as well, then run:

```bash
node test/doc-lint.js
node test/static-audit.js
```

## Known coverage boundaries

- External provider behavior (real rate limits, billing, SKU-specific errors) is not covered by default.
- Real SSH servers and non-default shells are not part of the default run.
- Browser checks depend on the installed Chrome/Edge version and may skip in headless CI without a browser.
- Windows is the primary development target; Linux/macOS behavior of native integrations is not exhaustively tested.
- Passing the suite does not prove every agent CLI or provider integration works; it proves the shared protocol and web layers behave as specified.
