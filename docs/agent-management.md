# Agent management

Open **Agent** in the sidebar to manage executors. Open **Models** for shared model connections, and **Environments** to group the same Agent configurations by computer.

The management page uses the prototype's catalog and workspace layout. Each Agent has one catalog entry; local, WSL and SSH installations appear inside its inspector. The overview shows real enabled-Agent, detected-environment, running-task and attention counts. Environment readiness describes CLI detection, not model-account authentication.

Use **Organize** to pin, reorder, hide or restore entries. These preferences are saved on the backend. Hidden Agents keep their sessions and remain enabled unless explicitly disabled. The overview can filter ready, attention, disabled and hidden entries; the search also matches configured models, connections and environments.

## Configure an Agent

1. Select an Agent, then choose a local, WSL or SSH environment tile. Use **Add Agent** for executors that are not in the catalog.
2. The inspector shows a summary. Choose **Edit configuration** to change the default connection, model, reasoning effort, or permissions.
3. Open **Advanced settings** to change that computer's command or upgrade command. Local executable paths and upgrade commands are separate from remote ones. Saving and checking do not execute upgrades.
4. Save, or cancel to restore the saved values. Unsaved drafts remain available when switching between Agent configurations during the same page visit.

Defaults are stored separately for each Agent and environment. An environment override takes precedence over the existing global Agent defaults. Changing connections does not carry a model or reasoning setting from the previous connection.

Existing conversations keep their model and permission choices. The context shortcut for copying a task also keeps that task's explicit choices. To start from the environment defaults, use **New task** in the Agent inspector; choose the environment, an existing project or another directory, and an optional description. Creating the conversation fills the description as a composer draft; click **Send** to run it. Switching environments clears the project directory while preserving the description.

The inspector's **Recent sessions** opens actual conversations for that Agent and computer. **View all** returns to the workspace with the Agent filter applied.

The regular empty composer also shows the selected environment's defaults. Switching computers clears an incompatible project directory and updates the default connection, model, effort, and permissions.

## Share model connections

Connections are managed once in **Models → Connections**. In the model catalog, choose **Assign to Agent**, select the Agent and environment, then inspect and save the filled configuration. Assignment is not saved until **Save configuration** is clicked.

Only Agents compatible with the selected connection appear in the assignment dialog. DSH manages models through its own Profile; its inspector links to environment configuration instead. Executors without an AgentHub permission bridge display self-managed permissions.

Existing configuration profiles represent global defaults. Explicit environment configurations take precedence over a global profile.

## Check an environment

**Check environment** runs a bounded, on-demand CLI check. SSH checks distinguish a failed host connection from a missing or failed CLI. Reading the Agent catalog does not connect to SSH hosts.

CLI detection does not verify model API credentials, quota, billing, or model output. ACP adapters verify the protocol when a conversation starts; a launcher version is not presented as proof of an ACP connection. Built-in and ACP Agents are local integrations.

Read-only users can browse configurations but cannot save, add Agents, create tasks, or execute diagnostics.

## Tools and availability

**Tools & permissions** contains the target-specific default permission mode and supported per-Agent controls for project permission memory, third-party MCP servers, the controlled browser and AgentHub tools. Global tool settings remain the upper limit. MCP counts distinguish configured servers, last-tested tools and untested servers; local counts do not describe a remote host.

Turning off project permission memory prevents remembered grants from approving subsequent tools. Native CLI/ACP MCP changes take effect when a new conversation starts. A CLI's own independently configured tools remain under that CLI's control. Skill, MCP-server and assistant actions open their existing managers.

Use **Disable** in Advanced settings to stop creating new tasks with an Agent. Existing conversations and running tasks are preserved and can still be used. Re-enable it from the inspector or directory.

## Add a custom Agent

**Add Agent** opens a searchable preset directory. Choosing a preset enables its catalog entry and opens configuration; it does not install software. Choose **Custom CLI / ACP**, enter its name and executable, and put optional arguments in the separate arguments field. Creating a custom Agent appends a new identity and preserves existing Agents. Test the command before using it for a task.

## Appearance

The **Studio / 清简** theme applies the demo's light palette, restrained borders, spacing, and typography to the workspace, controls, and dialogs. Select it from **Appearance**; the choice is remembered in that browser. Existing saved theme preferences remain available.

On narrow screens, **Open Agent catalog** expands the catalog above the workspace; choosing an Agent closes it. Cards and settings rows adapt to the available width. The inspector tabs support arrow keys, Home, and End.

## Upgrading a running instance

Restart the backend after updating the server files, then refresh the browser. The catalog API is version 2. An older backend can display the page, but organization, enable/disable and tool-preference controls stay disabled with a restart notice until the new API is loaded.

For focused server tests, run `node test/agent-center.js`. See [Testing](testing.md) for the wider suite and coverage boundaries.
