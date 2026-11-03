# Management centers

AgentHub uses a shared catalog layout for Agent, model and capability management. The Studio theme uses the same restrained surfaces, navigation, controls and line icons throughout the workspace and dialogs. Other themes keep their own colors.

The same controls, typography and surfaces are defined for all built-in pages by the [interface design system](interface-design.md), including workspace tools, statistics, resources, file and terminal panels, menus and authentication.

The application mark, favicon and native Agent badges use the same local SVG family. The sidebar groups Browser and Toolbox above a compact row of workspace tools; hidden actions do not leave empty grid columns.

## Models

Open **Models** from the workspace sidebar.

- **Model catalog** compares model entries across connections. Search by name or ID, filter by connection and capability, and inspect reported context limits. Identical IDs on different connections remain separate entries. Unknown capabilities and limits stay unmarked.
- **Connections** stores API endpoints and credentials once for reuse across compatible Agents. A generic API connection works independently of optional local discovery. Model synchronization and connection checks run when requested.
- **Global presets** saves a selected set of Agent defaults. Copy a preset to create a variant, then apply it explicitly. Duplicate names are rejected. Applying a preset preserves existing sessions and explicit environment defaults.

Use **Assign** on a model to choose a compatible Agent and environment. Inspect the filled draft and select **Save configuration** in Agent management. A model selection does not launch an inference request.

In a connection editor, empty secret fields retain saved keys. Replacing or clearing a key pool and the independent image key is explicit. Existing credentials are not filled back into the form. Imported read-only connections can be copied without their secrets.

## Capabilities

Open **Capabilities** from the sidebar or the shared management navigation.

### Skills

The skill library separates project and global sources, supports search and status filters, and keeps enable switches separate from preview buttons. Agent and computer selectors scan the selected target's project, native global, built-in, shared and plugin-cache directories. A failed SSH connection shows an error and does not fall back to local files. Plugin-cache discovery identifies available source files; it does not certify that every cached plugin version is active.

**View** opens a rendered description and highlighted Markdown source. The tabs support arrow keys, Home and End. The backend reads only discovered skill files with a bounded size. Read-only tokens may browse metadata but cannot retrieve full source.

Import a directory containing `SKILL.md` or a skill ZIP into the selected Agent's directory on the selected computer. A directory source belongs to that computer; ZIP files come from the browser's computer. Successful directory imports clear the old filters so the imported skill is visible. Local enable switches control AgentHub delivery per Agent. Native CLI discovery still follows that CLI's rules, and the page does not offer a misleading remote delivery switch.

Built-in, ACP and custom executors also retain access to the legacy `.claude/skills` import location. New shared imports use `.agents/skills`, with shared entries preferred over legacy duplicates at the same scope.

### MCP servers

The MCP page groups configured servers, status filters, import actions and connection tests. It does not connect to every server while listing them. **Test connection** initializes a server and reads its tool directory on demand. Tool totals are labeled as the last successful test result.

The editor separates local command and remote HTTP fields. Environment variables and authentication headers are folded into optional sections. Existing masked credentials and enable state are preserved on edits. Agent assignments apply to subsequent local sessions; remote CLIs use the remote computer's configuration.

The native section reads Claude, Codex, ZCode, Gemini and OpenCode configuration on the selected local, WSL or SSH computer. **Edit connection** changes only explicitly supplied fields, preserves undisplayed arguments and credentials, backs up the source file and rejects stale revisions. **Install into this Agent** adds a native project or global entry. Codex and OpenCode expose their native enable flag; other CLIs retain their own activation rules. Unknown custom formats are not rewritten. Listing metadata does not start a server or reveal stored secrets.

## Ordinary chat

Ordinary chat and `/btw` can search and read public webpages through `web_search` and `web_fetch` when the chosen model supports tool calls and the server has network access. They do not receive file or command tools. Internal commit-message generation explicitly disables web access. Search failures appear as tool results; successful tool support alone does not guarantee that an external provider or search engine is reachable.

### Assistants

An assistant defines a role and system prompt. Name, description and prompt are the primary fields; optional defaults for new sessions are folded below them. Editing a disabled assistant retains its disabled state. Built-in and default avatars use shared vector icons; custom avatar characters are preserved.

Assistant prompt support depends on the selected executor. Selecting a role does not imply every CLI supports system-prompt injection.

## Settings and navigation

Settings uses a section sidebar on larger screens and a section picker on narrow screens. Assistants and MCP sections link to their capability pages. Executor compatibility settings and detailed global tool permissions are folded by default. The save footer stays reachable while scrolling.

The same management navigation connects Agents, Models, Capabilities and Settings. Narrow layouts expose the catalog through a menu that closes after a selection. Returning to the workspace preserves a typed draft. Initial session restoration and WebSocket recovery do not replace an open manager; a deferred session refresh runs on return when appropriate.

Model lists render a bounded batch with **Show more**. Search updates the list rather than replacing the editor or the entire page. The new centers add no background polling, and dialog backdrops use a flat overlay instead of a full-page blur.

Small Mermaid diagrams retain their natural size initially, with explicit zoom controls available. Subsecond request durations are displayed in milliseconds.

## Acceptance checklist

Use an isolated data directory, synthetic API keys and a local model fixture for writes and model rounds.

1. Create and edit a generic connection, retain empty secret fields, synchronize models and inspect a refused connection. Cancel deletion and confirm the connection remains.
2. Filter a catalog, inspect metadata, assign a model to one Agent/environment and save explicitly. Confirm another environment and an existing session retain their configuration.
3. Create, copy and apply a partial global preset. Check duplicate-name feedback and retained form input.
4. Preview skill Markdown and source, toggle and reload its status, filter by scope, and import into an isolated project.
5. Explicitly test a local MCP fixture, toggle it, edit its description and verify authoritative counts. Create and edit an assistant, including while it is disabled.
6. Open managers during initial page loading, return through Settings, and confirm session messages, usage and a draft survive.
7. Check light and dark themes, mobile navigation, narrow layouts and expanded editor sections. Verify horizontal content stays inside the page or its intended scroller.
8. Verify read-only controls and server rejection of writes. Do not treat a successful local fixture as validation of every external provider or SSH host.

After upgrading backend code, restart the running AgentHub service to load new routes. Frontend JavaScript and CSS use `no-store`; reload the page to load the updated controllers and styles.
