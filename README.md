# bb-plugin-executor

Connects an [Executor](https://github.com/UsefulSoftwareCo/executor) v2 server
to BB. Its tools (`search`, `describe`, `call`, `execute`, `skills`) work in
every thread, and you decide which Executor actions run without asking.

## Setup

Open **Executor** in the sidebar, enter the server's MCP URL and an Executor
API key, and press **Save**. Without a key, save the URL and press
**Sign in** instead.

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

Executor accepts only its own tokens, so Cloudflare Access can't hand it one.
Instead, give the plugin both:

- an Executor API key under **Access token**, and
- a Cloudflare Access service token (client ID and secret) that the Access
  application's Service Auth policy allows.

The plugin sends them on every request, as `Authorization: Bearer` and
`CF-Access-Client-Id` / `CF-Access-Client-Secret`.

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
