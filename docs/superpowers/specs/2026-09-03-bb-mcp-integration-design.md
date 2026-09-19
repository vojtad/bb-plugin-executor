# Design: bb-plugin-mcp - MCP tools for every BB thread

Date: 2026-09-05 (compacted; supersedes 2026-09-03)
Status: Implemented in this repository, and kept in step with it. The BB
evidence below was read against /Users/vojtadrbohlav/dev/bb @ f6868ad0c and has
not been re-checked since; where this document and the code disagree, the code
is right and this document is the defect.

## 1. Goal and constraints

Every BB thread, on any provider, can call tools from MCP servers - local stdio
servers (chrome-devtools, victorialogs, victoriametrics) and remote HTTP servers
(Notion, Slack, Gmail) - with context cost controlled per project.

- Personal setup, configured from the BB UI, shared across enrolled machines.
- Ships as a BB plugin, not a core patch.
- Write actions ask for confirmation; reads do not.
- Tools are selected per project, never dumped into every thread.

Scope: v1 covers both transports - stdio and remote OAuth servers - on the
shared registry/catalog/bridge/consent core. Remote is what delivers the
measured savings in section 8b, so it is not deferrable. Stdio is the cheaper
half and needs none of the OAuth machinery, so build it first within v1 to get
the core exercised, then add section 9 on top; both ship together.

Both OAuth paths are in v1: Dynamic Client Registration for Notion and Slack,
and a manual client id/secret path for every server that does not offer it. The
manual path is a small subtraction from the DCR flow - skip
discovery-and-register, read the credentials saved on that server's own record -
so the expensive part of Gmail is the user's own GCP project and Developer
Preview enrollment, not plugin code.

## 2. Why a plugin

BB already injects plugin tools into every provider through one `dynamicTools`
array: Claude Code wraps them in an in-process MCP server `bb-bridge`
(`plugins/provider-claude-code/src/bridge/tool-proxy-mcp.ts`), ACP spawns a
stdio `bb-bridge`, Codex takes native `DynamicToolSpec` with no MCP at all
(`provider-codex/src/session-params.ts:649-657`), Pi registers through a tools
file (`provider-pi/src/bridge/bb-pi-extension.ts:~290`). A plugin that is an
MCP client and republishes remote tools needs no per-provider work, and every
call passes through BB where writes can be gated.

Per-provider MCP config was rejected: four formats, four OAuth flows, nothing
for Pi, no shared UI, no write gate.

## 3. Architecture

    stdio child processes (npx/docker) --stdin/stdout--+
    Notion / Slack --Streamable HTTP-------------------+--> bb-plugin-mcp (BB server process)
        registry | client pool | stdio | oauth | catalog | bridge | consent | ui
                        --registerTool + configure--> dynamicTools
                        --> claude-code | codex | acp | pi

One server-side instance serves every thread on every machine: one OAuth, one
config, no sync. Stdio servers therefore run on the BB server machine, not next
to the thread's workspace (section 6b).

## 4. Components (v1)

| Module        | Responsibility                                                      |
| ------------- | ------------------------------------------------------------------- |
| `registry`    | Server records + OAuth client, project overrides, per-tool flags    |
| `client-pool` | One MCP SDK client per server; lazy connect; reconnect on next call |
| `stdio`       | Spawn/idle-stop/crash policy, stderr ring buffer, PATH resolution   |
| `oauth`       | PKCE, DCR or a per-server manual client, callback, refresh          |
| `catalog`     | Cached `tools/list`, resolved names, stale flags                    |
| `bridge`      | `$ref` flattening, MCP <-> BB content translation, timeouts         |
| `consent`     | Per-tool `ask` flag, prompt, per-thread allow cache                 |
| `ui`          | One panel: servers + status + Connect; defaults + project overrides |

State: `bb.storage.database()` + `bb.storage.migrate()`
(`packages/plugin-sdk/src/backend-contract.ts:171-190`), not KV (256 KiB cap,
`host-policy.ts:73`). Everything per-server lives there, the OAuth client id,
secret and scopes next to the tokens they mint. Manifest secret settings (0600
file, `backend-contract.ts:69`) can hold neither: their keys are a fixed set
declared in the manifest, and the servers needing a client of their own are an
open list - Slack, Google, a self-hosted deployment, a second account for a
service already configured. The plugin declares no settings at all.

## 5. Tool naming: passthrough, prefix only on collision

Constraints: `[a-zA-Z0-9_-]+` (`host-policy.ts:96`), unique across all loaded
plugins, not `update_environment_directory` - the only reserved name
(`host-policy.ts:68-70`). Notion self-namespaces (`notion-search`, ...), so a
prefix yields `notion_notion-search` and breaks Notion's own docs.

One plugin, one namespace. Per-service plugins buy nothing: `collectAgentTools()`
walks all plugins against one flat `seen` set, sorted by plugin id, first wins
(`plugin-service.ts:1021-1036`); Claude Code exposes exactly one MCP server
(`bridge.ts:2288`). The model-visible name already differs by provider
(`mcp__bb-bridge__notion-search` on Claude Code, `tool-proxy-mcp.ts:70-74`;
bare on Codex and Pi), so exact names are not portable anyway - descriptions
carry the semantics and pass through verbatim.

Policy:

1. Register the upstream name verbatim.
2. On collision with another server in this plugin, a reserved name, or the
   length budget: prefix with the server slug (`slack_search`).
3. Persist the resolved name per (server, upstream name) at first sync. Adding
   Slack later must never rename Notion's tools.
4. Log every disambiguation and show it in the panel.

Collisions with *other plugins* are undetectable at registration: `registerTool`
returns silently and only sets a status detail (`plugin-api.ts:1085-1091`,
`plugin-runtime.ts:418-424`; test `plugin-agent-tools.test.ts:418`), and no SDK
surface lists other plugins' tools. Accept it; near zero for the target servers.

Length: Claude Code prepends 16 characters. If the Anthropic tool-name cap is 64
(verify against the Agent SDK), the upstream budget is 48; prefix past that.

`registerTool` is global; `configure()` selects and may override parameters,
never names (`backend-contract.ts:846-856`). Two servers never enabled together
still collide on a bare `search`.

## 6. Registration lifecycle

`registerTool` works after load - it guards only on `assertLive()` and reports
post-load collisions immediately (`plugin-api.ts:993,1085-1091`). The contract
restricts only hot-adding to a *running provider session*.

- **Load**: register from the SQLite catalog; no network on the load path.
- **Background**: a `bb.background.schedule` refreshes catalogs and registers
  the diff only - a same-plugin re-registration throws (`plugin-api.ts:1093`).
- **Never reload.** Dispose interrupts the plugin's pending interactions with
  `plugin-disposed` (`plugin-runtime.ts:1616`), stops services and drains
  in-flight `execute()` for 5 s each (`:262,:678-694`), then invalidates the
  handle. Self-reload via `bb.sdk.plugins.reload` stalls on its own drain.
- No `unregisterTool`: a tool gone upstream stays registered - mark stale,
  `execute` returns an actionable `isError`.
- Notices go to the panel via `bb.realtime.publish`; `PluginStatusApi` has only
  `needsConfiguration` (`backend-contract.ts:1542-1551`), which leaves `running`.

**When tools reach a session.** Both providers apply a changed set at the next
session *construction*, never on a turn into a live session. Claude Code
rebuilds on `thread/resume` when `sessionConstructionConfig` (includes
`dynamicTools`, `bridge.ts:960`) is not `isDeepStrictEqual` (`bridge.ts:2336`).
Codex always releases the existing session on `thread/resume` and constructs
with the new tools (`provider-codex/src/bridge/bridge.ts:847-850,930`); only its
turn path ignores tools (`constructionSignature` `:446-460`, checked
`:1272-1290`). UI copy: "takes effect on the next thread".

**Schemas** use the JSON-schema overload. Pi rebuilds into TypeBox with no
`$ref`/`$defs` branch, so those degrade to `Unknown`
(`bb-pi-extension.ts:120-155`). Dereference non-recursive local `$ref`s before
registering; BB rejects only recursive chains (`host-policy.ts:1738-1790`). A
cyclic schema cannot be flattened: skip the tool and say so.

**Results.** `normalizeAgentToolResult` accepts only `text` and `image`
(`plugin-service.ts:513-560`); anything else throws as `Tool "x" failed`. Map
audio/resource/resource_link to text, `structuredContent` to JSON text when
`content` is empty. No size cap exists on the result path: cap text ~128 KiB,
images ~2 MiB.

Per-server glyphs must be declared in the manifest's
`bb.branding.experimental_icons` (`backend-contract.ts:758-765`): bundle
Notion/Slack/Gmail, fall back to the plugin glyph.

## 6b. Stdio servers

**Placement.** `server.ts` runs in the BB server process, so a stdio server
spawns on the BB server machine. A thread on a remote enrolled machine gets the
tools, but a filesystem or git server sees the BB server's disk, not that
workspace - the documented v1 limitation. It fits the targets: chrome-devtools
drives the browser on the Mac that also runs the BB server; the victoria
servers are network clients.

Host-side execution exists but is deferred: a `bb.host` entry runs as a worker in
each host daemon (keep-awake spawns `caffeinate` there,
`plugins/keep-awake/host.ts:19,77`), called with
`bb.hosts.experimental_client().call(method, input, { hostId })`
(`backend-contract.ts:1507-1515`; host id from `configure()`'s
`context.host.id`). Workers fork with the daemon's login-shell PATH
(`plugin-host-manager.ts:447-459`), 10 s start, 5 min idle stop, 5 s SIGKILL
grace (`:114-117,963-985`), no auto-restart (`host-contract.ts:33-40`). The
blocker: every call is fixed at `COMMAND_TIMEOUT_MS` 30 s + 6 s grace, 8 MiB
(`constants.ts:1`, `plugin-host-rpc.ts:14-15,83`) and `call()` takes no
timeout (`plugin-api.ts:1254-1284`). Needs an async call shape first.

**Lifecycle.** Spawn on demand (first call or background sync), never at load -
no-network-at-load becomes no-spawn-at-load, so an uncached stdio server
contributes nothing until the first sync seconds later. Idle stop after 10 min;
crash -> respawn on next call; three failed spawns in 5 min -> `failed` until
retried. One process per server shared by all threads; stateful servers
(chrome-devtools: one browser) interleave threads - document it. `bb.onDispose`
runs before the 5 s drain (`plugin-runtime.ts:1622-1632`): SIGTERM, 2 s,
SIGKILL, so an in-flight call loses its child and returns `isError`. Spawn in a
new process group, record PIDs in SQLite, kill still-matching PIDs at load;
docker gets `--rm --name mcp-<slug>` for the same cleanup.

**Config.** `command`, `args[]`, `env{}`, `cwd` (default plugin data dir),
`initTimeoutMs`. No shell; child env = configured `env` over `PATH`+`HOME` only
(MCP SDK default). Env values carry API tokens: plaintext in plugin SQLite,
write-only in the UI - same posture as remote tokens; secret settings are static
keys and cannot hold a dynamic list.

**PATH.** The server resolves no login-shell PATH (grep `resolveUserShellPath`
in `apps/server`: none); only the daemon does (`start-host-daemon.ts:173-179`).
`npx`/`docker` resolution depends on how the server was launched - the failure
class of the user's three unreachable Claude Code stdio servers. Resolve the
login-shell PATH once (`$SHELL -lic 'echo $PATH'`, as `runtime-shell-env.ts:322`
does), allow absolute `command`, and ship a Test button that spawns,
initializes, and shows the stderr tail Claude Code hides.

**Security.** A stdio record is command execution as the BB server user,
configured from a form. It adds no capability the plugin lacks - plugins are
unsandboxed Node in the server process; the install path has no trust gate
(grep `trust` in `apps/server/src/services/plugins`: none) - but a marketplace
plugin exposing such a form should say so. `local`-auth routes only; show the
full command line before saving; never `shell: true`.

**Edge cases.** First `npx -y`/`docker pull` takes minutes: 60 s init timeout
on first spawn, 15 s after. Stderr -> 100-line ring buffer per server, shown in
the panel, never inherited. No `initialize` reply -> kill, `failed to
initialize` + tail. Docker needs the socket and app running; launchd-started
servers lack `/usr/local/bin` and Docker's bin on PATH. Child exit mid-call ->
`isError`, respawn next call. `cwd` is server-side; workspace-relative servers
wait for host-side.

## 7. Consent

**Classification.** Each tool has an `ask` flag: `false` when
`readOnlyHint: true`, else `true`; editable in the per-project tool table.
`readOnlyHint` is optional and often absent, so the flag, not the annotation,
is the source of truth.

**The plugin owns the gate.** Claude Code pre-allowlists every plugin tool
(`allowedTools = getAllowedToolNames(...)`, `bridge.ts:2289`) so `canUseTool`
never fires; Codex forwards `item/tool/call` without an approval hook; ACP and
Pi likewise.

**Prompt.** `bb.ui.requestInput()` inside `execute()`, as `ask-user-question`
does (`plugins/ask-user-question/src/server.ts:53-60`). Payload 64 KiB, title
160 chars (`packages/domain/src/plugin-interaction-limits.ts`); timeout default
10 min, max 1 h (`plugin-api.ts:572-580`). Truncate displayed arguments.
`rendererId` resolves in *this plugin's* app bundle
(`pending-interactions.ts:204-206`): the plugin ships a React entry.

**One pending interaction per thread** (`pending-interactions.ts:476-481`,
409). Claude and Codex emit parallel calls, so: per-thread promise chain before
`requestInput`, allow cache consulted *after* the chain so "allow for this
thread" from the first prompt covers the second. The slot is also held by the
provider's own questions and permission prompts - on 409 return
`isError: "user is answering another prompt; retry"`.

**Decisions** allow-once / allow-for-thread / deny, cached
`Map<threadId, Set<tool>>`, evicted on `thread.archived` / `thread.deleted`
(`backend-contract.ts:271-273`). `PluginAgentToolContext` has no `turnId`
(`:730-737`); per-turn scoping is impossible.

**Headless turns are identifiable.** The `message.dispatch` hook context
carries `origin` (`app|cli|sdk|plugin`), `originPluginId`, and
`startedOnBehalfOf { initiator: agent|system, senderThreadId }`
(`backend-contract.ts:436-443`; `server-contract/src/api/threads.ts:56,89-93`);
`bb.sdk.threads.spawn` defaults origin to `plugin` + caller id. Record the last
dispatch origin per thread from a pass-through handler. For `initiator: system`,
`origin: plugin`, or `parentThreadId != null`: no prompt - deny writes unless
the project has "auto-allow writes".

**Timeouts.** Consent 2 min, MCP call 90 s; both run inside one `execute()`, so
their sum must stay under the transport ceiling.

**Cancellation.** `ctx.signal` is the daemon HTTP request's signal
(`apps/server/src/internal/tool-calls.ts:88`); the daemon's `callTool` is a
bare `fetch` (`host-daemon/src/server-client.ts:578`), `runSessionRequest` adds
nothing (`app.ts:262-275`), so it fires only on connection loss. Thread stop
*does* cancel a pending prompt (`thread-lifecycle.ts:1591` ->
`cancelled/thread-stopped`); nothing cancels an in-flight MCP request. Send
upstream only after consent; pass `AbortSignal.timeout` + `ctx.signal` to the
SDK's `callTool`.

**Transport ceiling ~5 min.** No dispatcher is configured (grep
`setGlobalDispatcher|bodyTimeout`: none), so undici's 300 s `bodyTimeout`
applies: headers go out at once, the body only when the promise resolves
(`tool-calls.ts:24-42`). Inferred - measure it and Claude Code's own MCP tool
timeout before relying on either.

## 8. Per-project selection

`configure()` is synchronous at `thread.start` / `turn.submit`
(`backend-contract.ts:1246-1268`) and resolves `context.project.id` against an
in-memory snapshot replaced atomically on refresh.

Selection is defaults plus overrides, not a per-project allow list. Each tool
carries a global `default_enabled`, and a project's binding row overrides it
force-on or force-off, so what a project gets is
`defaults - forcedOff + forcedOn`. An allow list cannot express "on
everywhere": reaching a project created a second ago would mean enumerating
projects that do not exist yet. Recording the projects that DISAGREE is a read
of the bindings table instead, which also takes `bb.sdk.projects.list` off the
load path - nothing is hydrated before the first `configure()` can answer, so
neither is its failure mode. The cost is set arithmetic per resolution rather
than one map lookup. Fail-closed covers the plugin's whole selection (unknown
name, >256 ids, bad override): validate before returning, and sort before the
cap truncates, or the model is offered a different 256 tools each time.

A disabled server's tools are excluded from the selection. The flag was inert
while a tool needed a per-project tick to be seen at all; it stops being inert
the moment one row can spread a tool to every project at once.

All personal threads share `proj_personal` (`project.kind === "personal"`),
which is where Notion is most wanted; make that binding explicit in the UI.

The panel's tool table is scoped by a picker whose first entry is all projects
at once. There it edits the defaults, one checkbox per tool, with bulk on and
off over whatever the filters currently show. On a single project it edits that
project's overrides: per row, inherit the default - rendered as on or off, so
the consequence is visible without looking the tool up - or pin it always-on or
off. Rows filter by free text and by server, both client-side, and the panel
reports how many tools the chosen project resolves to against the 256 cap,
alongside the estimated token cost of that same resolved set. Per tool it shows
`ask`, the resolved name, and that tool's estimated token cost.

## 8b. Cost control - the measured case

Measured 2026-09-05 with `claude -p "say ok" --output-format json`:

| Setup                                      | Prompt tokens |
| ------------------------------------------ | ------------- |
| Claude Code, no MCP                        | 50,329        |
| + 12 claude.ai connectors                  | 238,052       |
| + 4 connectors (Notion, Gmail, Cal, Drive) | 121,244       |

Schemas cost ~188k tokens at 12 connectors, ~71k at 4; BB overhead is 3-5k.
Sonnet's 200k window is why Sonnet subagents fail in a fully connected session.

Claude Code's `disabledMcpServers` is keyed by absolute cwd, so it never applies
to BB personal threads (fresh `env_*` per thread; 0 of 80 entries are BB
workspaces). The plugin keys on `projectId` and selects per tool where provider
config is per server.

`ENABLE_CLAUDEAI_MCP_SERVERS=0` gives 50,329 tokens (`--strict-mcp-config`:
50,328), and the plugin sets it on every Claude Code thread through
`bb.providers.experimental_contributeEnv` (`src/server/provider-env.ts`). BB
folds contributed entries into the thread environment after the shell env and
ships them as `options.envVars`, which `buildSessionEnv` spreads over
`process.env` (`bridge.ts:1695`, `readConfigEnvOverrides` at `:1708`) - so this
is per thread, not per machine. An earlier revision of this section said
per-project would need a core change because `config.envVars` was never
populated; the `contributeEnv` hook is that change, and it landed in BB 0.42 /
plugin SDK 0.4.47. `strictMcpConfig` is still set nowhere, so local stdio
servers in `~/.claude.json` remain separate and out of reach.

Codex has no counterpart. Its binary carries no environment variable for this
(only `CODEX_HOME`, `CODEX_SQLITE_HOME`, `CODEX_CONNECTORS_TOKEN`,
`CODEX_MCP_PROTOCOL_VERSION`, and sandbox/proxy vars), and contributed env
could not reach it in any case: BB maps it to
`shell_environment_policy.set.<KEY>` (`buildCodexConfig`), the environment for
shell commands the agent runs rather than the codex process, and codex runs as
one shared `app-server` per host with no per-thread process env. The switch is
the feature flag `features.apps`, set by hand in `~/.codex/config.toml`;
`codex debug prompt-input` measures 25,138 B down to 21,648 B with
`--disable apps`. Putting it in `buildCodexConfig` alongside the
`features.multi_agent` and `memories.*` keys BB already sends would make it
per thread, but that is an upstream change.

Limits: this governs only tools the plugin owns and cannot make a loaded schema
cheaper - only choose what loads.

The panel prices what loads, in the unit the table above is measured in. Per
tool, and summed over the set the chosen project resolves to:
`ceil((registeredName + description + JSON.stringify(inputSchema)) / 4)` - what
a provider actually ships for one tool, over a characters-per-token divisor.
The divisor is calibrated against this database, not guessed: the 42 Notion
tools catalogued total 197,377 such characters, which at 4 is ~49k tokens, and
Notion is by far the largest of the four connectors measured at ~71k above. At
3.5 Notion alone would claim ~56k and leave ~15k for the other three, which
that row does not support.

It ignores the JSON wrapper a provider puts around each tool and Claude Code's
16-character `mcp__bb-bridge__` name prefix; both are small beside a schema,
and no public tokeniser for Claude exists to do better. It is therefore always
rendered with a `~`, with no colour and no threshold: the readout is a
diagnostic, and a number a user can read against 200k needs no alarm attached
to it. The exact `schemaBytes` stays in the DTO - it is cheap and it is the one
figure that is not an estimate.

## 9. OAuth and credentials (remote servers)

Callback: `bb.http.route(..., { auth: "none" })` at
`<loopbackBaseUrl>/api/v1/plugins/mcp/http/oauth/callback`
(`backend-contract.ts:543-570`); a browser redirect carries no BB origin or
plugin token. `loopbackBaseUrl` is bind-gated (`:1442`): read it in handlers.
Persist `(state, pkce_verifier, server_id, expires_at)` in SQLite, single use,
10 min TTL, so a BB restart mid-flow does not strand the callback.

Notion and Slack support DCR: discover, register, PKCE, store. Where a server
does not - Google, a self-hosted deployment - the user saves a client id and
secret on that server's own record and the same PKCE flow runs without the
registration step. A saved client id is the whole signal and its absence is the
cue to register; there is no hostname heuristic, because which hosts need a
client of their own is not a question a pattern can answer. The panel shows the
callback URL to paste into the client's configuration, which Google and Slack
both demand and which used to exist only inside a thrown error.

Scopes are a separate per-server field rather than part of the client. Slack
registers its own client and still issues a token good for nothing unless the
authorize request names the scopes, so needing scopes and needing a manual
client are independent questions. `access_type=offline` and `prompt=consent` go
on every authorize request: Google issues no refresh token without them, and
RFC 6749 section 3.1 requires every other authorization server to ignore a
parameter it does not recognise.

Saving credentials destroys the server's existing grant. A token minted for a
different client id, or for narrower scopes, is not one the new configuration
can go on using, and leaving it would let the panel report "connected" over
credentials the service has already stopped honouring. `begin` also compares
the stored client id against the configured one before reusing a client, so the
invariant holds whether or not the caller remembered to forget.

Slack additionally needs "Enable MCP" turned on in workspace settings, which is
an admin action outside the plugin. Refresh at 75 % of `expires_in` from local
receipt time (ignore absolute `exp`; clock skew), single-flight; a 401 is
authoritative. Notion access tokens last ~8 h, refresh tokens expire at an
absolute 180 days: surface "reconnect" in the panel, not as an error. Retry a
401 once after refresh only for `readOnlyHint` tools; never auto-retry a write.

Tokens, and the client secrets that mint them, sit in the plugin's SQLite under
the BB data dir, filesystem-protected - the same posture as the cached opencode
token.

## 10. Error handling

Unreachable server, expired token, missing tool: `isError` with actionable
text; never fail the turn. Lost `Mcp-Session-Id` (server restart): re-initialize
once, then error. Stdio child exited or never initialized: `isError` with the
last stderr lines. `PluginContextStaleError` after dispose: `isError`. Never
clear a catalog on a failed or empty `tools/list`; mark rows stale, show
"0 tools since <time>".

## 11. Testing

- Catalog -> registration -> translation over the MCP SDK in-memory transport,
  including audio/resource degradation and size caps.
- Names: passthrough, collision, persistence across a later server, length.
- Consent: `ask` defaults, parallel calls, 409 from a foreign interaction,
  `thread-stopped`, headless deny.
- Stdio: spawn on demand not at load, idle stop, crash then respawn, three
  failures -> `failed`, dispose kills the child inside 5 s, stderr ring buffer,
  init timeout, PATH resolution with a bare `npx`.
- OAuth `state` + PKCE against a fake server, with a restart between
  redirect and callback.
- One cross-provider smoke test: same tool on Claude Code and Codex threads.

## 12. Risks

1. Prompt injection via results is unsolved and Gmail is the worst case (Google
   warns explicitly that message content can carry instructions that hijack a
   session). With Gmail in v1 this is accepted, not avoided: label untrusted
   result content, and default every Gmail tool to `ask` regardless of
   `readOnlyHint`, since reading an attacker-authored mail is itself the attack.
2. Unauthenticated callback route; `state` is its only protection.
3. Plaintext tokens on disk, and the per-server OAuth client secrets beside
   them.
4. Port-bound redirect URI; DCR re-registers if the port moves.
5. `experimental_` APIs (hooks, icons, host client).
6. Transport ceiling inferred, not read from BB.
7. Stdio records are UI-configured command execution on the BB server; env
   values (API tokens) are plaintext in the plugin SQLite.
8. Stdio servers run beside the BB server, not the thread's workspace.

## 13. Deferred / non-goals

- Per-resolution schema pruning (128 KiB override, narrowing only): per-tool
  selection drops `query-data-sources` outright, the only measured offender.
- Naming override modes.
- Gmail account setup (GCP project, OAuth client, Developer Preview enrollment)
  is the user's, not the plugin's; the plugin stores what the user creates and
  does nothing to obtain it.
- Multiple accounts per server. A second record for the same URL is just another
  server whose tools collide and get prefixed - the collision path then becomes
  the common case.
- Host-side stdio via a `bb.host` entry (section 6b): needs a call shape that
  outlives the fixed 30 s host RPC deadline. Per-project stdio instances.
- MCP resources, prompts, sampling, elicitation.

## Appendix: evidence

Paths relative to /Users/vojtadrbohlav/dev/bb @ f6868ad0c.

| Claim                                           | Location                                                     |
| ----------------------------------------------- | ------------------------------------------------------------ |
| One `bb-bridge` server, tools pre-allowlisted   | `plugins/provider-claude-code/src/bridge/bridge.ts:2283-2290` |
| `mcp__bb-bridge__` prefix                       | `plugins/provider-claude-code/src/bridge/tool-proxy-mcp.ts:70-74` |
| Claude rebuilds on `dynamicTools` diff at resume | `bridge.ts:960`, `:2326-2339`                               |
| Codex names verbatim                            | `plugins/provider-codex/src/session-params.ts:649-657`       |
| Codex signature omits tools (turn path only)    | `plugins/provider-codex/src/bridge/bridge.ts:446-460,1272-1290` |
| Codex resume always reconstructs                | `plugins/provider-codex/src/bridge/bridge.ts:847-850`        |
| Pi TypeBox rebuild, no `$ref`                   | `plugins/provider-pi/src/bridge/bb-pi-extension.ts:120-155`  |
| Flat first-wins namespace                       | `apps/server/src/services/plugins/plugin-service.ts:1021-1036` |
| Cross-plugin collision silent, status detail    | `plugin-api.ts:1085-1091`, `plugin-runtime.ts:418-424`, `apps/server/test/services/plugins/plugin-agent-tools.test.ts:418` |
| Same-plugin duplicate throws                    | `plugin-api.ts:1093`                                         |
| Name pattern, reserved, 256 ids, 128 KiB, KV cap | `packages/plugin-sdk/src/internal/host-policy.ts:68,73,96,101,103` |
| Only recursive `$ref` rejected                  | `host-policy.ts:1738-1790`                                   |
| `registerTool` / `configure` contract           | `packages/plugin-sdk/src/backend-contract.ts:1246-1300`      |
| Override narrows params, not names              | `backend-contract.ts:846-856`                                |
| Configure context (origin, project.kind, parent) | `backend-contract.ts:795-838`                               |
| Tool ctx has no turnId                          | `backend-contract.ts:730-737`                                |
| Result types text/image only, no size cap       | `plugin-service.ts:513-560`                                  |
| Status API: only `needsConfiguration`           | `backend-contract.ts:1542-1551`                              |
| Dispose: interrupt, 5 s stop, 5 s drain         | `plugin-runtime.ts:262,678-694,1596-1645`                    |
| One pending interaction per thread              | `apps/server/src/services/interactions/pending-interactions.ts:476-481` |
| Renderer must be in the calling plugin's bundle | `pending-interactions.ts:204-206`                            |
| Thread stop cancels plugin prompts              | `apps/server/src/services/threads/thread-lifecycle.ts:1591`  |
| Interaction limits and timeout                  | `packages/domain/src/plugin-interaction-limits.ts`, `plugin-api.ts:572-580` |
| `message.dispatch` hook exposes origin          | `backend-contract.ts:436-443`, `packages/server-contract/src/api/threads.ts:56,89-93` |
| `ctx.signal` = request signal; streamed body    | `apps/server/src/internal/tool-calls.ts:24-42,88`            |
| Daemon: bare fetch, no timeout/retry/abort      | `apps/host-daemon/src/server-client.ts:564-589`, `app.ts:262-275,547-558` |
| Unloaded plugin tool -> "Unsupported tool"      | `tool-calls.ts:83-99`                                        |
| Project delete emits `thread.deleted` per thread | `apps/server/src/services/projects/project-deletion.ts:180-184` |
| Env spread; `config.envVars` latent             | `bridge.ts:1691-1710`                                        |
| HTTP auth modes; loopback URL bind-gated        | `backend-contract.ts:543-570,1442`                           |
| Storage + migrate                               | `backend-contract.ts:171-190`                                |
| Host entry client and call options (no timeout) | `backend-contract.ts:1507-1515`, `packages/plugin-sdk/src/host-contract.ts:19-40`, `plugin-api.ts:1254-1284` |
| Host RPC fixed 30 s + 6 s grace, 8 MiB          | `apps/server/src/constants.ts:1`, `apps/server/src/services/plugins/plugin-host-rpc.ts:14-15,83-86` |
| Host worker: daemon fork with shell PATH        | `apps/host-daemon/src/plugin-host-manager.ts:447-459`        |
| Worker start 10 s, idle 5 min, SIGKILL grace 5 s | `plugin-host-manager.ts:114-117,963-985`                    |
| Worker not auto-restarted                       | `plugin-host-manager.ts:510-527`, `host-contract.ts:33-40`   |
| Daemon resolves login-shell PATH; server does not | `apps/host-daemon/src/start-host-daemon.ts:173-179`, `runtime-shell-env.ts:322` |
| Precedent: host entry spawns a process          | `plugins/keep-awake/host.ts:19,77`, `package.json` `bb.host` |
| Dispose hooks run before the invocation drain   | `plugin-runtime.ts:1622-1632`                                |

External: Notion MCP tools and client guide (developers.notion.com/guides/mcp),
Slack MCP server (docs.slack.dev/ai/slack-mcp-server), Gmail MCP
(developers.google.com/workspace/gmail/api/guides/configure-mcp-server).
