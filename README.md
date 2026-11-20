# bb-plugin-executor

Connects an [Executor](https://github.com/UsefulSoftwareCo/executor) v2 server
to BB. Its tools (`executor_search`, `executor_describe`, `executor_call`,
`executor_execute`, `executor_skills`) work in every thread, and you decide
which Executor actions run without asking.

## Setup

See [docs/setup.md](docs/setup.md): an example Executor deployment with Docker
and a Cloudflare Tunnel, Cloudflare Access, and connecting BB.

In short: open **Executor** in the sidebar, enter the MCP URL, add a Cloudflare
Access service token if Access protects Executor, press **Save**, then
**Sign in**. The panel lists your Executor apps and their accounts, links to
the dashboard, and checks apps for updates.

## Approvals

In Executor's model approval mode, the plugin decides when an action needs
approval, not the agent:

- If **Approve every Executor action** is on, or a rule matches, it runs.
- Otherwise a prompt appears in the thread: **Approve**, **Always approve**
  (adds a rule for that exact tool) or **Deny**.

A rule is an `app.tool` name such as `gmail.send`, or a prefix ending in `*`
such as `gmail.*`. Questions a tool asks for itself always go to you, even
with Approve all on.

A prompt left unanswered for three minutes counts as cancelled. Executor's
other approval modes, where these rules are not used, are described in
[docs/setup.md](docs/setup.md#approval-modes).

## How it works

- In model mode a paused `execute` or `call` comes back to the plugin, which
  answers it through `resume`. Agents never see `resume`. In native mode
  Executor asks over MCP instead; in browser mode the plugin waits for the
  answer given on Executor's page.
- Each tool call opens its own MCP session.
- Tools are registered as `executor_search`, `executor_call` and so on: bare
  names like `search` collide with other plugins and are hard for an agent to
  find. Adding an app in Executor needs no reload; the app list in the agent
  instructions refreshes with every sync.
- Tools and apps are cached and refreshed every 17 minutes, or with
  **Refresh**. BB can't update a registered tool, so when an Executor upgrade
  changes one the panel offers **Reload**, which cancels open prompts in every
  thread.
- Claude Code threads run with `ENABLE_CLAUDEAI_MCP_SERVERS=0`, so claude.ai
  connectors don't load alongside Executor. For Codex, set
  `[features] apps = false` in `~/.codex/config.toml` yourself.

`bb executor status` prints the connection, tools and rules.

## Development

```bash
npm install
npm run verify   # lint, typecheck, tests, build
bb plugin install . --yes
```
