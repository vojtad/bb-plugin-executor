# bb-plugin-executor

Connects an [Executor](https://github.com/UsefulSoftwareCo/executor) v2 server
to BB. Its tools (`search`, `describe`, `call`, `execute`, `skills`) work in
every thread, and you decide which Executor actions run without asking.

## Setup

Open **Executor** in the sidebar, enter the server's MCP URL and press
**Save**. Then press **Sign in**, or paste a personal access token and press
**Save** again.

## Approvals

When an Executor action needs approval, the plugin decides, not the agent:

- If **Approve every Executor action** is on, or a rule matches, it runs.
- Otherwise a prompt appears in the thread: **Approve**, **Always approve**
  (adds a rule for that exact tool) or **Deny**.

A rule is an `app.tool` name such as `gmail.send`, or a prefix ending in `*`
such as `gmail.*`. Questions a tool asks for itself always go to you, even
with Approve all on.

A prompt left unanswered for three minutes counts as cancelled.

## Behind Cloudflare Access

Executor accepts only tokens it issued itself, so Cloudflare Access must let
the plugin's own requests through. Add a **Bypass** policy for these paths:

- `/mcp`
- `/.well-known/`
- `/api/auth/oauth2/`

Keep the dashboard behind Access. To have Cloudflare verify you when the
plugin signs in, make Cloudflare Executor's login: add an Access for SaaS OIDC
app and set `SSO_DISCOVERY_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` and
`SSO_ALLOWED_DOMAINS` on the Executor container.

## How it works

- The plugin connects with `?elicitation_mode=model`. A paused `execute` or
  `call` comes back to the plugin, which answers it through `resume`. Agents
  never see `resume`. Native mode is not used: Executor skips approval for
  `call` there, trusting a client confirmation that BB does not ask for.
- Each tool call opens its own MCP session.
- Tools are registered from a cached tool list and refreshed every 17
  minutes. BB can't update a registered tool, so when Executor changes one
  the panel offers **Reload**, which cancels open prompts in every thread.
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
