# bb-plugin-executor

Connects one [Executor](https://github.com/UsefulSoftwareCo/executor) server
(v1 or v2) to BB. Its tools (`execute`, `skills`, and on v2 `call`, `search`,
`describe`) work in every thread, and you decide which Executor actions run
without asking.

## Setup

Open **Executor** in the sidebar, enter the server's MCP URL and press
**Save**. Then either press **Sign in** (OAuth), or paste an access token
first (v2 personal access token, or a v1 local server key).

On v2, choose **Native** approvals on Executor's consent page if it asks.

## Approvals

When an action needs approval in Executor, Executor asks BB, not the agent:

- If **Approve every Executor action** is on, or a rule matches the tool, it
  runs.
- Otherwise a prompt appears in the thread: **Approve**, **Always approve**
  (adds a rule for that exact tool) or **Deny**.

A rule is an exact tool name such as `tools.google_gmail.user.me.send`, or a
prefix ending in `*`. Questions a tool asks for itself (pick a calendar, sign
in somewhere) always go to you, even with Approve all on.

A prompt left unanswered for three minutes counts as cancelled.

## How it works

- The plugin connects with `?elicitation_mode=native`, so Executor sends
  approvals as MCP elicitation requests. A URL that already sets
  `elicitation_mode` is used as it is.
- Each tool call opens its own MCP session, so an approval request always
  belongs to one call in one thread.
- Tools are registered from a cached tool list and refreshed every 17
  minutes. Adding an integration changes `execute`'s description, and BB
  can't update a registered tool. The panel then offers **Reload**, which
  cancels open prompts in every thread.
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
