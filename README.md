# bb-plugin-executor

Connects an [Executor](https://github.com/UsefulSoftwareCo/executor) v2 server
to BB. Its tools (`search`, `describe`, `call`, `execute`, `skills`) work in
every thread, and you decide which Executor actions run without asking.

## Setup

Open **Executor** in the sidebar, enter the server's MCP URL, press **Save**,
then **Sign in**. Executor asks which approval mode to use: keep **model**.
The plugin warns if the connection runs in any other mode, because then
approvals would not reach BB.

An Executor API key works instead of signing in: open **API key** in the
panel.

The panel lists your Executor apps and their accounts, and links to the
dashboard. Agents get the same list with each new session.

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

Executor accepts only its own tokens, so the plugin passes Access with a
service token and then signs in to Executor as usual:

1. In Cloudflare Zero Trust, create a service token.
2. On the Executor Access application, add a **Service Auth** policy that
   allows it. Keep your own **Allow** policy: the browser sign-in still goes
   through Access.
3. Enter the token's client ID and secret under **Cloudflare Access** in the
   panel.

The plugin sends the token, as `CF-Access-Client-Id` and
`CF-Access-Client-Secret`, only to the Executor host.

## How it works

- The plugin connects with `?elicitation_mode=model`. A paused `execute` or
  `call` comes back to the plugin, which answers it through `resume`. Agents
  never see `resume`. Native mode is not used: Executor skips approval for
  `call` there, trusting a client confirmation that BB does not ask for.
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
