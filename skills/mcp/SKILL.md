---
name: mcp
description: Use when a task needs a tool from a connected MCP server (Notion, Slack, Gmail, a local stdio server), before telling the user a service or capability is unavailable, when an MCP tool call fails or asks for confirmation, or when the user asks what MCP servers or tools are available.
---

# MCP servers

This plugin connects MCP servers to BB and exposes their tools to you.

## MCP tools are ordinary tools

There is no separate MCP call surface. A tool keeps the name its server gives
it, passed through verbatim - `search`, `create-page`. Only a name two servers
both want gets a `<server>_` prefix, on whichever was synced second. This
plugin never adds an `mcp_` prefix; if you see one, it belongs to your
provider's wrapper around every BB tool. Call them as you would any other tool.

Which tools you have is decided per project, and a tool can also be on by
default in every project, with a project overriding it on or off. So a tool you
expect but cannot find is not missing - it is off by default and not switched
on here, switched off for this project, disabled, or from a server that was
never synced. A tool you did not expect to have is one the user made a default
everywhere. A name that is not in your list is off rather than hidden, and the
fix is the MCP panel, not a workaround - unless it sits behind a door.

## Some tools are doors

A door is a tool that reaches services which are not in your tool list under
their own names. Your instructions for this thread name every door you have
and what each one reaches - read that list before telling anyone a service is
unavailable. A tool list scanned for a Notion-shaped name says no every time,
and saying so is wrong.

`bb mcp list` prints the same thing, and does not involve a search. The MCP
panel shows it on each server's row, for the user.

Three ways a door can present itself:

1. **It names its services in its own description.** Executor's `execute` does
   this: a bullet list of integrations. So "Can you use Notion?" is answerable
   from a description you already have.
2. **It names them in the tool names.** A Cloudflare MCP portal forwards each
   upstream server's tools as `<server>_<tool>` - `github_list_issues` - so
   the services are visible in your tool list, just not as tools of their own.
3. **It names them nowhere, and you have to ask.** A portal in code mode
   replaces every upstream tool with `portal_codemode_search` and
   `portal_codemode_execute`. Then:
   - Call `portal_list_servers` to learn which servers are behind it. There is
     nothing to read; this is the only way.
   - Use `portal_codemode_search` to find a tool, then
     `portal_codemode_execute` to run it, writing JavaScript against the
     `codemode.<tool>` proxy.
   - An upstream server may need its own sign-in, separately from the
     portal's. The user does that in Cloudflare, not you.

## Your provider may be holding the description back

Some providers do not put every tool's description in front of you. Claude
Code lists a plugin tool by name alone and loads its description only when you
search for it by keyword, and that search matches whole words - a query for
"notion" need not reach `execute`, which is the tool that reaches Notion.

So a search that found nothing is not an answer about what you can do:

- Load the tool by exact name instead of by keyword. In Claude Code that is
  `ToolSearch` with `select:<name>`, and the name may carry your provider's
  own prefix for BB tools: `select:mcp__bb-bridge__execute`.
- Or run `bb mcp list`, which involves no search at all. It also prints what
  each door reaches.
- Another MCP server failing to connect says nothing about these tools. This
  plugin's tools reach you as ordinary provider tools, so a connection error
  about some server in your provider's own MCP list is about that server
  alone.

## Write tools ask the user first

Every tool the server does not mark read-only prompts the user for
confirmation before it runs, once per thread per tool. That prompt is not an
error and not something to route around:

- Wait for it. A prompt that is pending is not a failed call.
- If the user declines, the call returns a refusal. Accept it, tell the user
  what you were going to do, and stop. Do not retry the same call, look for an
  unguarded tool that does the same thing, or split the write into smaller
  calls to slip under the prompt.
- Read-only tools never prompt, so exploring is cheap. Prefer reading before
  writing.

## Seeing what is configured

Run `bb mcp` (or `bb mcp list`) in a shell. It prints every configured server,
its transport and command or URL, and the tools each one contributes. It is
read-only and safe to run at any time.

The full view - adding a server, connecting an OAuth account, choosing which
tools a project gets - is the **MCP** panel in the BB sidebar. Adding a server
means typing a command line or completing a browser sign-in, so it belongs to
the user. Point them at the panel rather than attempting it.

## When a call fails

- **"is no longer configured"** - the server was removed. Tell the user; do
  not try to add it back.
- **"rejected the stored credentials" / "reconnect"** - the OAuth grant
  expired. The error carries the reason the authorization server gave, and
  that reason is the part to repeat: "reconnect it" is sometimes the whole
  answer and sometimes only a day's reprieve. Cloudflare Access, for one, ends
  a grant after the application's Grant session duration - 24 hours by default
  - so reconnecting will work and then fail again tomorrow unless the setting
  is raised. Ask the user to press Reconnect in the MCP panel, and pass on
  whatever else the message said. You cannot fix any of this from a tool call.
- **A stdio server that will not start** - the error carries the tail of the
  process's stderr. Report that text; it is usually a missing binary or a
  wrong path, which the user fixes in the panel.
- **A tool that is stale** - the server no longer advertises it. A sync in the
  panel will clear it.

Report these to the user as they are. The only one worth a second call is a
write that was refused for credentials, and only once: a 401 is refused before
the tool runs, so nothing changed, and the failure drops the connection so the
next call reconnects. Everything else on this list needs the user, not a
retry.

A call that TIMED OUT is not on this list, and is the one case to be careful
with: the request was abandoned at this end, not cancelled at the other, so an
upstream write may still land. Do not repeat a timed-out write - say what
happened and let the user check.
