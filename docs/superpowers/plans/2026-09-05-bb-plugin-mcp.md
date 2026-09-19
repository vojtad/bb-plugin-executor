# bb-plugin-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A BB plugin that connects to MCP servers (local stdio and remote
OAuth) and republishes their tools as BB native tools, so threads on every
provider can use them, with context cost controlled per project.

**Architecture:** The plugin is an MCP host living in the BB server process. It
caches each server's tool catalog in its own SQLite, registers every cached tool
through `bb.agents.registerTool`, and selects a per-project subset in
`bb.agents.configure`. BB's existing `dynamicTools` rail delivers them to
claude-code, codex, acp and pi with no per-provider work. Writes are gated by a
plugin-owned consent prompt because BB pre-allowlists plugin tools.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/sdk` 1.30, zod 4,
better-sqlite3 via `bb.storage.database()`, React 19 + vendored BB shadcn UI,
Vitest with `@get-bb/plugin-sdk/testing`.

**Spec:** `docs/superpowers/specs/2026-09-03-bb-mcp-integration-design.md`

## Global Constraints

- Plugin id is `mcp` (package name `bb-plugin-mcp`). Tool names must match
  `[a-zA-Z0-9_-]+`, be globally unique across all loaded plugins, and avoid the
  single reserved name `update_environment_directory`.
- TypeScript, ESM, `"type": "module"`. Keep `typescript` and `@types/*` in
  `devDependencies`. This repo intentionally uses the bb 0.41 TS scaffold style,
  not the plain-JS style of bb-plugin-prompt-stash.
- All source text ASCII-only. Verify with
  `LC_ALL=C grep -n '[^[:print:][:space:]]' <changed files>` before commit.
- Runtime deps go in `dependencies`. Radix, sonner, vaul, clsx, tailwind-merge,
  class-variance-authority, `@pierre/diffs` are host-shimmed: keep them in
  `devDependencies`.
- Vendored UI is imported as `@/components/ui/<name>`, never a relative path.
- `bb.storage.migrate(db, statements)` treats the array index as the migration
  id. Append only. Never edit or reorder a shipped statement.
- RPC input must be strict JSON. Never send a key whose value is `undefined`;
  omit the key.
- Every timer, child process, service and MCP client must be released in
  `bb.onDispose`. Dispose hooks run before `drainInvocations`, so this is the
  correct place to kill stdio children.
- `bb.server.loopbackBaseUrl` is bind-gated: read it inside handlers and
  services, never at factory scope.
- The consent prompt and the MCP call both run inside one `execute()`. Their
  timeouts must sum to well under 5 minutes (undici `bodyTimeout` on the daemon
  tool-call round trip). Use 2 min consent, 90 s MCP call.
- Writes under `~/dev` require sandbox escalation
  (`dangerouslyDisableSandbox: true`) for git, npm, build and test commands.
- Commands: `npm install --include=dev`, `npm run lint`, `npm test`,
  `bb plugin build`, `npm run verify`. Install once with
  `bb plugin install . --yes`, then `bb plugin reload mcp` after each build.

---

## File Structure

| File | Responsibility |
| ---- | -------------- |
| `server.ts` | Composition root only. Build stores, wire surfaces, register dispose. No logic. |
| `contract.ts` | Zod RPC contract shared by `server.ts` and `app.tsx`. |
| `src/storage/schema.ts` | Migration statements and row types. |
| `src/storage/registry.ts` | CRUD for servers, project bindings, tool catalog, per-tool flags. |
| `src/storage/oauth-store.ts` | Token rows and pending authorization states. |
| `src/mcp/schema-tools.ts` | JSON Schema `$ref` flattening, cycle detection, sanitising. |
| `src/mcp/content.ts` | MCP content parts to BB `PluginAgentToolContentPart`. |
| `src/mcp/naming.ts` | Resolve upstream tool names to registered names. |
| `src/mcp/transport.ts` | `McpTransport` interface plus http and stdio factories. |
| `src/mcp/stdio.ts` | Child process spawn, PATH resolution, stderr ring buffer, supervision. |
| `src/mcp/client-pool.ts` | One MCP client per server; connect, `listTools`, `callTool`. |
| `src/catalog.ts` | Sync `tools/list` into the registry; diff against registered names. |
| `src/consent.ts` | Read/write classification, per-thread mutex, decision cache, prompt. |
| `src/oauth/pkce.ts` | Verifier/challenge/state generation. |
| `src/oauth/discovery.ts` | AS metadata discovery and Dynamic Client Registration. |
| `src/oauth/flow.ts` | Authorize URL, callback exchange, refresh. |
| `src/server/tools.ts` | `registerTool` wiring and the `execute` path. |
| `src/server/configure.ts` | Per-project tool selection for `bb.agents.configure`. |
| `src/server/routes.ts` | OAuth callback HTTP route. |
| `src/server/rpc.ts` | RPC handlers over the registry. |
| `src/server/services.ts` | Catalog refresh schedule and token refresh service. |
| `src/ui/connections-panel.tsx` | Server list, status, Connect, per-project tool table. |
| `src/ui/consent-prompt.tsx` | Pending-interaction renderer for write confirmation. |
| `app.tsx` | `definePluginApp`: nav panel plus pending-interaction renderer. |
| `tests/*.test.ts` | Vitest suites, flat directory at repo root. |

---

## Task 1: Manifest, storage schema, registry store

**Files:**
- Modify: `package.json` (manifest block, dependencies)
- Create: `src/storage/schema.ts`, `src/storage/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Transport = "stdio" | "http";
  export interface ServerRecord {
    id: string;              // slug, [a-z0-9-]+
    displayName: string;
    transport: Transport;
    url: string | null;              // http only
    command: string | null;          // stdio only
    args: string[];                  // stdio only
    env: Record<string, string>;     // stdio only
    cwd: string | null;              // stdio only
    enabled: boolean;
    createdAt: number;
  }
  export interface CatalogTool {
    serverId: string;
    upstreamName: string;
    registeredName: string;   // persisted at first sync, never reassigned
    description: string;
    inputSchema: Record<string, unknown>;
    readOnly: boolean;        // from annotations.readOnlyHint, default false
    ask: boolean;             // consent flag, defaults to !readOnly
    stale: boolean;
    syncedAt: number;
  }
  export interface Registry {
    listServers(): ServerRecord[];
    getServer(id: string): ServerRecord | undefined;
    upsertServer(record: ServerRecord): void;
    deleteServer(id: string): void;
    listTools(serverId?: string): CatalogTool[];
    getToolByRegisteredName(name: string): CatalogTool | undefined;
    replaceCatalog(serverId: string, tools: CatalogTool[]): void;  // marks missing stale
    setToolAsk(serverId: string, upstreamName: string, ask: boolean): void;
    listBindings(projectId: string): string[];              // enabled registeredNames
    setBinding(projectId: string, registeredName: string, enabled: boolean): void;
    prune(validProjectIds: Set<string>): void;
  }
  export function createRegistry(db: Database.Database): Registry;
  export const MCP_MIGRATIONS: string[];
  ```

- [ ] **Step 1: Update the manifest**

In `package.json` set `bb.name` to `"MCP"`, `bb.description` to
`"Connect MCP servers - local stdio and remote OAuth - and use their tools in every thread."`,
`bb.branding.icon` to `"PlugSocket"`. Add to `dependencies`:
`"@modelcontextprotocol/sdk": "^1.30.0"`. Delete `skills/example-todos/`
and remove `bb.skills` if present. Run
`npm install --include=dev`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/registry.test.ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MCP_MIGRATIONS } from "../src/storage/schema.js";
import { createRegistry } from "../src/storage/registry.js";

function db() {
  const handle = new Database(":memory:");
  for (const statement of MCP_MIGRATIONS) handle.exec(statement);
  return handle;
}

describe("registry", () => {
  it("round-trips a server and its catalog", () => {
    const registry = createRegistry(db());
    registry.upsertServer({
      id: "notion", displayName: "Notion", transport: "http",
      url: "https://mcp.notion.com/mcp", command: null, args: [], env: {},
      cwd: null, enabled: true, createdAt: 1,
    });
    registry.replaceCatalog("notion", [{
      serverId: "notion", upstreamName: "notion-search",
      registeredName: "notion-search", description: "Search",
      inputSchema: { type: "object" }, readOnly: true, ask: false,
      stale: false, syncedAt: 1,
    }]);
    expect(registry.listTools("notion")).toHaveLength(1);
    expect(registry.getToolByRegisteredName("notion-search")?.readOnly).toBe(true);
  });

  it("marks vanished tools stale instead of deleting them", () => {
    const registry = createRegistry(db());
    registry.upsertServer({
      id: "s", displayName: "S", transport: "http", url: "https://x/mcp",
      command: null, args: [], env: {}, cwd: null, enabled: true, createdAt: 1,
    });
    const tool = {
      serverId: "s", upstreamName: "gone", registeredName: "gone",
      description: "", inputSchema: { type: "object" }, readOnly: true,
      ask: false, stale: false, syncedAt: 1,
    };
    registry.replaceCatalog("s", [tool]);
    registry.replaceCatalog("s", []);
    expect(registry.getToolByRegisteredName("gone")?.stale).toBe(true);
  });

  it("keeps per-project bindings independent", () => {
    const registry = createRegistry(db());
    registry.setBinding("proj_a", "notion-search", true);
    expect(registry.listBindings("proj_a")).toEqual(["notion-search"]);
    expect(registry.listBindings("proj_b")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test -- tests/registry.test.ts`
Expected: FAIL, cannot resolve `../src/storage/schema.js`.

- [ ] **Step 4: Implement schema and registry**

`src/storage/schema.ts` exports `MCP_MIGRATIONS`, an append-only array of raw
SQL strings. Tables: `servers`, `tools` (primary key `(server_id,
upstream_name)`, unique index on `registered_name`), `bindings` (primary key
`(project_id, registered_name)`), `oauth_tokens`, `oauth_pending`. Store JSON
columns (`args`, `env`, `input_schema`) as TEXT and parse at the boundary.
Booleans as INTEGER 0/1.

`src/storage/registry.ts` implements `createRegistry` over prepared statements.
`replaceCatalog` runs in a single transaction: upsert every incoming tool with
`stale = 0`, then set `stale = 1` on rows for that server not in the incoming
set. Never delete, and never change an existing `registered_name`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/registry.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Verify ASCII and commit**

```bash
LC_ALL=C grep -n '[^[:print:][:space:]]' package.json src/storage/*.ts tests/registry.test.ts
git add package.json package-lock.json src/storage tests/registry.test.ts
git rm -r --cached skills 2>/dev/null || true
git commit -m "Add the MCP registry store

Servers, tool catalog and per-project bindings live in the plugin's own
SQLite because the catalog is the source of truth for registration at load.
Vanished tools are marked stale rather than deleted so a resolved tool name
is never reassigned to a different upstream tool."
```

---

## Task 2: Schema flattening and content translation

**Files:**
- Create: `src/mcp/schema-tools.ts`, `src/mcp/content.ts`
- Test: `tests/schema-tools.test.ts`, `tests/content.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // schema-tools.ts
  export function flattenSchema(schema: unknown): Record<string, unknown>;
  export class RecursiveSchemaError extends Error {}
  // content.ts
  import type { PluginAgentToolContentPart } from "@get-bb/plugin-sdk";
  export function toBbContent(
    content: unknown, structuredContent?: unknown,
  ): PluginAgentToolContentPart[];
  export const MAX_TEXT_BYTES = 128 * 1024;
  ```

**Why this exists:** BB rejects cyclic `$ref` at registration, and Pi rebuilds
parameters into TypeBox with no `$ref` support at all, so a schema using
`$defs` degrades to `Unknown` there. Flattening non-recursive refs fixes both.
BB accepts only `text` and `image` content parts; anything else throws and
becomes a generic tool failure.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/schema-tools.test.ts
import { describe, expect, it } from "vitest";
import { flattenSchema, RecursiveSchemaError } from "../src/mcp/schema-tools.js";

describe("flattenSchema", () => {
  it("inlines a non-recursive local $ref", () => {
    const flat = flattenSchema({
      type: "object",
      properties: { a: { $ref: "#/$defs/leaf" } },
      $defs: { leaf: { type: "string" } },
    });
    expect(flat).toEqual({
      type: "object", properties: { a: { type: "string" } },
    });
  });

  it("throws on a cyclic $ref", () => {
    expect(() => flattenSchema({
      type: "object",
      properties: { self: { $ref: "#/$defs/node" } },
      $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
    })).toThrow(RecursiveSchemaError);
  });

  it("coerces a non-object root to an empty object schema", () => {
    expect(flattenSchema(null)).toEqual({ type: "object" });
    expect(flattenSchema({ type: "string" })).toEqual({ type: "object" });
  });
});
```

```ts
// tests/content.test.ts
import { describe, expect, it } from "vitest";
import { toBbContent } from "../src/mcp/content.js";

describe("toBbContent", () => {
  it("passes text and image through", () => {
    expect(toBbContent([
      { type: "text", text: "hi" },
      { type: "image", data: "AAA", mimeType: "image/png" },
    ])).toEqual([
      { type: "text", text: "hi" },
      { type: "image", data: "AAA", mimeType: "image/png" },
    ]);
  });

  it("summarises content types BB rejects", () => {
    const parts = toBbContent([
      { type: "audio", data: "AAA", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///x.txt", text: "body" } },
    ]);
    expect(parts.every((part) => part.type === "text")).toBe(true);
    expect(JSON.stringify(parts)).toContain("file:///x.txt");
  });

  it("falls back to structuredContent when content is empty", () => {
    expect(toBbContent([], { rows: 2 })).toEqual([
      { type: "text", text: JSON.stringify({ rows: 2 }, null, 2) },
    ]);
  });

  it("truncates oversized text", () => {
    const [part] = toBbContent([{ type: "text", text: "x".repeat(200_000) }]);
    expect(part.type).toBe("text");
    if (part.type === "text") {
      expect(part.text.length).toBeLessThan(200_000);
      expect(part.text).toContain("truncated");
    }
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -- tests/schema-tools.test.ts tests/content.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement both modules**

`flattenSchema` walks the schema, resolving `#/$defs/...` and `#/definitions/...`
pointers by substitution, tracking the resolution stack to throw
`RecursiveSchemaError` on a cycle. Drop `$defs`/`definitions` from the output.
If the root is not an object with `type: "object"`, return `{ type: "object" }`.

`toBbContent` maps `text` and `image` verbatim, converts `audio` to
`[audio, <mimeType>, N bytes]` text, converts `resource` and `resource_link`
to text naming the uri and inlining `text` when present, and falls back to
pretty-printed `structuredContent` when the content array is empty. Truncate
any text part over `MAX_TEXT_BYTES` with a trailing
`... [truncated, N bytes total]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/schema-tools.test.ts tests/content.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
LC_ALL=C grep -n '[^[:print:][:space:]]' src/mcp/*.ts tests/schema-tools.test.ts tests/content.test.ts
git add src/mcp tests/schema-tools.test.ts tests/content.test.ts
git commit -m "Flatten JSON Schema refs and translate MCP content

BB rejects cyclic \$ref at registration and Pi rebuilds parameters into
TypeBox with no \$ref support, so a schema using \$defs would silently
degrade to Unknown there. BB also accepts only text and image parts, so
audio and embedded resources are summarised rather than dropped."
```

---

## Task 3: Tool name resolution

**Files:**
- Create: `src/mcp/naming.ts`
- Test: `tests/naming.test.ts`

**Interfaces:**
- Consumes: `CatalogTool`, `Registry` from Task 1.
- Produces:
  ```ts
  export const MAX_NAME_LENGTH = 48;  // 64 minus "mcp__bb-bridge__"
  export interface NameResolution { registeredName: string; renamedFrom?: string; }
  export function resolveName(args: {
    serverId: string;
    upstreamName: string;
    taken: ReadonlySet<string>;
  }): NameResolution;
  ```

**Why 48:** Claude Code exposes plugin tools as `mcp__bb-bridge__<name>`, a
16-character prefix, against a 64-character provider limit.

- [ ] **Step 1: Write the failing test**

```ts
// tests/naming.test.ts
import { describe, expect, it } from "vitest";
import { resolveName } from "../src/mcp/naming.js";

describe("resolveName", () => {
  it("passes an upstream name through untouched", () => {
    expect(resolveName({
      serverId: "notion", upstreamName: "notion-search", taken: new Set(),
    })).toEqual({ registeredName: "notion-search" });
  });

  it("prefixes with the server slug on collision", () => {
    expect(resolveName({
      serverId: "slack", upstreamName: "search", taken: new Set(["search"]),
    })).toEqual({ registeredName: "slack_search", renamedFrom: "search" });
  });

  it("suffixes when even the prefixed name is taken", () => {
    const result = resolveName({
      serverId: "slack", upstreamName: "search",
      taken: new Set(["search", "slack_search"]),
    });
    expect(result.registeredName).toBe("slack_search_2");
  });

  it("sanitises characters outside the allowed set", () => {
    expect(resolveName({
      serverId: "s", upstreamName: "get files/list", taken: new Set(),
    }).registeredName).toBe("get_files_list");
  });

  it("truncates to the provider budget", () => {
    const long = "a".repeat(80);
    const result = resolveName({ serverId: "s", upstreamName: long, taken: new Set() });
    expect(result.registeredName.length).toBeLessThanOrEqual(48);
  });

  it("never returns the reserved bb tool name", () => {
    expect(resolveName({
      serverId: "s", upstreamName: "update_environment_directory", taken: new Set(),
    }).registeredName).not.toBe("update_environment_directory");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/naming.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Replace every character outside `[a-zA-Z0-9_-]` with `_`, collapse runs of `_`,
trim to `MAX_NAME_LENGTH`. If the result is free and not
`update_environment_directory`, return it. Otherwise prefix `<serverId>_`
(sanitised, re-truncated) and return it with `renamedFrom` set. If that is also
taken, append `_2`, `_3`, ... until free.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/naming.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/naming.ts tests/naming.test.ts
git commit -m "Resolve MCP tool names, prefixing only on collision

Notion already self-namespaces every tool, so an unconditional server prefix
would produce notion_notion-search and break its documented names. Prefix
only when a name is genuinely taken, and budget length against Claude Code's
mcp__bb-bridge__ prefix rather than the raw 64-character provider limit."
```

---

## Task 4: MCP client pool over HTTP

**Files:**
- Create: `src/mcp/transport.ts`, `src/mcp/client-pool.ts`
- Test: `tests/client-pool.test.ts`

**Interfaces:**
- Consumes: `ServerRecord` (Task 1).
- Produces:
  ```ts
  export interface DiscoveredTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    readOnly: boolean;
  }
  export interface McpCallResult {
    content: PluginAgentToolContentPart[];
    isError: boolean;
  }
  export interface ClientPool {
    listTools(server: ServerRecord): Promise<DiscoveredTool[]>;
    callTool(
      server: ServerRecord, toolName: string, args: Record<string, unknown>,
      options: { signal: AbortSignal; timeoutMs: number },
    ): Promise<McpCallResult>;
    close(serverId: string): Promise<void>;
    closeAll(): Promise<void>;
  }
  export interface ClientPoolDeps {
    /** Injected so tests can supply an in-memory transport. */
    createTransport(server: ServerRecord): Promise<Transport>;
    getAuthHeader?(serverId: string): Promise<Record<string, string>>;
    log: { warn(message: string): void; info(message: string): void };
  }
  export function createClientPool(deps: ClientPoolDeps): ClientPool;
  ```

**Notes for the implementer:** use `Client` from
`@modelcontextprotocol/sdk/client/index.js` and
`StreamableHTTPClientTransport` from
`@modelcontextprotocol/sdk/client/streamableHttp.js`. Cache one connected
client per `server.id`. On any transport error, close and drop the cached
client so the next call reconnects; do not implement backoff. Pass `signal`
and `timeout` straight into the SDK's `callTool` options rather than wrapping
with `Promise.race`. Read `readOnly` from `tool.annotations?.readOnlyHint`,
defaulting to `false` when absent.

- [ ] **Step 1: Write the failing test**

```ts
// tests/client-pool.test.ts
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClientPool } from "../src/mcp/client-pool.js";
import type { ServerRecord } from "../src/storage/registry.js";

const server: ServerRecord = {
  id: "fake", displayName: "Fake", transport: "http", url: "https://x/mcp",
  command: null, args: [], env: {}, cwd: null, enabled: true, createdAt: 1,
};

function fakeUpstream() {
  const mcp = new McpServer({ name: "fake", version: "1.0.0" });
  mcp.registerTool("echo", {
    description: "Echo text",
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ text }) => ({ content: [{ type: "text", text }] }));
  return mcp;
}

function pool() {
  return createClientPool({
    async createTransport() {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await fakeUpstream().connect(serverSide);
      return clientSide;
    },
    log: { warn: vi.fn(), info: vi.fn() },
  });
}

describe("client pool", () => {
  it("lists tools with their readOnly annotation", async () => {
    const tools = await pool().listTools(server);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "echo", readOnly: true });
    expect(tools[0].inputSchema.type).toBe("object");
  });

  it("calls a tool and translates its content", async () => {
    const result = await pool().callTool(server, "echo", { text: "hello" }, {
      signal: new AbortController().signal, timeoutMs: 5_000,
    });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("reuses one client across calls", async () => {
    const createTransport = vi.fn(async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await fakeUpstream().connect(serverSide);
      return clientSide;
    });
    const shared = createClientPool({ createTransport, log: { warn: vi.fn(), info: vi.fn() } });
    await shared.listTools(server);
    await shared.listTools(server);
    expect(createTransport).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/client-pool.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the pool**

`src/mcp/transport.ts` exports `createHttpTransport(server, headers)` returning
a `StreamableHTTPClientTransport`. `src/mcp/client-pool.ts` implements
`createClientPool` with a `Map<string, Promise<Client>>` so concurrent callers
share one connection attempt. Convert results through `toBbContent` from Task 2
and `flattenSchema` for each discovered `inputSchema`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/client-pool.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/transport.ts src/mcp/client-pool.ts tests/client-pool.test.ts
git commit -m "Add the MCP client pool

One client per server, shared by every thread, with the transport injected so
tests run against the SDK's in-memory pair instead of a network server. A
transport error drops the cached client so the next call reconnects; there is
no backoff because a single user on one process cannot stampede."
```

---

## Task 5: Stdio servers

**Files:**
- Create: `src/mcp/stdio.ts`
- Modify: `src/mcp/transport.ts` (add the stdio factory)
- Test: `tests/stdio.test.ts`, `tests/fixtures/echo-mcp-server.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface StdioSupervisor {
    transportFor(server: ServerRecord): Promise<Transport>;
    stderrTail(serverId: string): string[];
    killAll(): Promise<void>;
  }
  export function createStdioSupervisor(deps: {
    resolvePath(): Promise<string>;
    log: { warn(message: string): void };
  }): StdioSupervisor;
  export function loginShellPath(): Promise<string>;
  ```

**Why `loginShellPath` exists:** the BB server does no login-shell PATH
resolution (only the host daemon does), so `npx` and `docker` may be missing
from the server's environment. This is the most likely reason the user's three
existing stdio servers fail today. Resolve the PATH once via
`$SHELL -lc 'echo $PATH'`, cache it, and fall back to `process.env.PATH`.

**Lifecycle rules:** spawn on first use, never at plugin load. Keep a 100-line
stderr ring buffer per server, never inherit stderr. Kill with SIGTERM, then
SIGKILL after 2 s. Spawn detached in a new process group so a hard BB kill does
not orphan children. Never use `shell: true`. Child env is the configured `env`
over `{ PATH, HOME }` only.

- [ ] **Step 1: Create the fixture server**

```js
// tests/fixtures/echo-mcp-server.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

process.stderr.write("fixture starting\n");
const server = new McpServer({ name: "echo-fixture", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo text", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);
await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/stdio.test.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientPool } from "../src/mcp/client-pool.js";
import { createStdioSupervisor } from "../src/mcp/stdio.js";
import type { ServerRecord } from "../src/storage/registry.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "fixtures", "echo-mcp-server.mjs",
);
const server: ServerRecord = {
  id: "echo", displayName: "Echo", transport: "stdio", url: null,
  command: process.execPath, args: [fixture], env: {}, cwd: null,
  enabled: true, createdAt: 1,
};
let supervisor: ReturnType<typeof createStdioSupervisor> | null = null;
afterEach(async () => { await supervisor?.killAll(); supervisor = null; });

describe("stdio supervisor", () => {
  it("spawns a child and lists its tools", async () => {
    supervisor = createStdioSupervisor({
      resolvePath: async () => process.env.PATH ?? "", log: { warn: vi.fn() },
    });
    const pool = createClientPool({
      createTransport: (record) => supervisor!.transportFor(record),
      log: { warn: vi.fn(), info: vi.fn() },
    });
    const tools = await pool.listTools(server);
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("captures child stderr instead of inheriting it", async () => {
    supervisor = createStdioSupervisor({
      resolvePath: async () => process.env.PATH ?? "", log: { warn: vi.fn() },
    });
    const pool = createClientPool({
      createTransport: (record) => supervisor!.transportFor(record),
      log: { warn: vi.fn(), info: vi.fn() },
    });
    await pool.listTools(server);
    expect(supervisor.stderrTail("echo").join("\n")).toContain("fixture starting");
  });

  it("kills every child on killAll", async () => {
    supervisor = createStdioSupervisor({
      resolvePath: async () => process.env.PATH ?? "", log: { warn: vi.fn() },
    });
    const pool = createClientPool({
      createTransport: (record) => supervisor!.transportFor(record),
      log: { warn: vi.fn(), info: vi.fn() },
    });
    await pool.listTools(server);
    await supervisor.killAll();
    expect(supervisor.stderrTail("echo")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test -- tests/stdio.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement the supervisor**

Use `StdioClientTransport` from
`@modelcontextprotocol/sdk/client/stdio.js`, passing `command`, `args`, `env`,
`cwd`, and `stderr: "pipe"`. Attach a line reader to the child's stderr that
pushes into a bounded array of 100 entries. Track children in a
`Map<string, { transport, child }>`. `killAll` sends SIGTERM, waits 2 s, then
SIGKILL, and clears the stderr buffers.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/stdio.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/stdio.ts src/mcp/transport.ts tests/stdio.test.ts tests/fixtures
git commit -m "Run local stdio MCP servers

Children spawn on first use, never at plugin load, so an unreachable server
cannot delay BB startup. The BB server resolves no login-shell PATH, which is
the likely reason npx- and docker-based servers fail today, so resolve it once
and keep the child's stderr in a ring buffer for a diagnosable Test button."
```

---

## Task 6: Catalog sync, tool registration, per-project selection

**Files:**
- Create: `src/catalog.ts`, `src/server/tools.ts`, `src/server/configure.ts`
- Test: `tests/agent-surfaces.test.ts`

**Interfaces:**
- Consumes: `Registry`, `ClientPool`, `resolveName`, `flattenSchema`.
- Produces:
  ```ts
  export interface Catalog {
    /** Fetch tools/list for one server and persist the diff. Returns added names. */
    sync(serverId: string): Promise<string[]>;
    syncAll(): Promise<void>;
  }
  export function createCatalog(deps: {
    registry: Registry; pool: ClientPool;
    log: { warn(message: string): void; info(message: string): void };
  }): Catalog;

  export function registerCatalogTools(bb: BbPluginApi, deps: {
    registry: Registry; execute: ToolExecutor;
  }): void;
  export type ToolExecutor = (
    tool: CatalogTool, args: Record<string, unknown>, ctx: PluginAgentToolContext,
  ) => Promise<PluginAgentToolResult>;

  export function registerConfigure(bb: BbPluginApi, deps: {
    selection: () => ReadonlyMap<string, ReadonlySet<string>>;  // projectId -> names
  }): void;
  ```

**Critical lifecycle fact:** `registerTool` is NOT restricted to plugin load.
`plugin-api.ts` handles post-load registration explicitly, so the background
sync may register newly discovered tools live. They reach a thread when its
provider session is next constructed. Never ask the user to reload: reload
cancels every pending interaction on every thread and drains in-flight calls
after 5 s.

A cross-plugin name collision is NOT reported back to the plugin --
`registerTool` reports a status detail and returns silently. Detect it by
keeping our own set of names we asked for and treating a later "unknown tool"
at execute time as the failure signal.

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent-surfaces.test.ts
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server.js";

const context = {
  thread: { id: "t1", title: null, parentThreadId: null, sourceThreadId: null },
  project: { id: "proj_a", kind: "standard" as const, name: "A", gitRemoteUrl: null },
  environment: {
    id: "e1", name: null, path: null,
    workspaceProvisionType: "unmanaged" as const, branchName: null,
  },
  host: { id: "h1", name: "local" },
  provider: { id: "codex", model: "m", capabilities: { supportsNativeUserQuestion: false } },
  origin: { kind: null, pluginId: null },
};

let host: Awaited<ReturnType<typeof createFakePluginHost>> | null = null;
afterEach(async () => { await host?.harness.lifecycle.dispose(); host = null; });

describe("agent surfaces", () => {
  it("registers nothing when no server is configured", async () => {
    host = createFakePluginHost({ pluginId: "mcp" });
    await plugin(host.bb);
    const resolved = await host.harness.behavior.resolveAgentConfiguration(context);
    expect(resolved.tools).toEqual([]);
  });

  it("selects only tools bound to the thread's project", async () => {
    host = createFakePluginHost({ pluginId: "mcp" });
    await plugin(host.bb);
    await host.harness.behavior.callRpc("servers_add", {
      displayName: "Echo", transport: "stdio",
      command: process.execPath, args: ["tests/fixtures/echo-mcp-server.mjs"],
    });
    await host.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
    await host.harness.behavior.callRpc("binding_set", {
      projectId: "proj_a", registeredName: "echo", enabled: true,
    });

    const mine = await host.harness.behavior.resolveAgentConfiguration(context);
    expect(mine.tools.map((tool) => tool.name)).toEqual(["echo"]);

    const other = await host.harness.behavior.resolveAgentConfiguration({
      ...context, project: { ...context.project, id: "proj_b" },
    });
    expect(other.tools).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/agent-surfaces.test.ts`
Expected: FAIL, RPC methods do not exist yet.

- [ ] **Step 3: Implement catalog, tool registration and configure**

`createCatalog.sync` calls `pool.listTools`, resolves each name against the
union of already-registered names, writes the catalog through
`registry.replaceCatalog`, and returns names that are new. A failed
`listTools` leaves the catalog untouched and logs; it must never clear rows.

`registerCatalogTools` iterates `registry.listTools()` and calls
`bb.agents.registerTool` for each non-stale row, using the raw JSON Schema
overload with the already-flattened `inputSchema`, and a `presentation.label`
of `{ pending: "Running <upstreamName>", completed: "Ran <upstreamName>" }`.
`execute` looks the tool up by registered name and delegates to the injected
`ToolExecutor`; a stale or unknown row returns
`{ content: [...], isError: true }` naming the server.

`registerConfigure` calls `bb.agents.configure` synchronously, reading a
snapshot map. Replace that map atomically on change rather than mutating it,
because `configure` runs synchronously while the background sync writes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/agent-surfaces.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/catalog.ts src/server tests/agent-surfaces.test.ts
git commit -m "Register catalog tools and scope them per project

Registration reads the cached catalog so the load path never touches the
network. registerTool works after load, so a background sync adds new tools
live; the alternative would be asking the user to reload, which cancels every
pending interaction and drains in-flight calls across all threads."
```

---

## Task 7: Consent gate

**Files:**
- Create: `src/consent.ts`, `contract.ts` (consent payload/response schemas)
- Modify: `src/server/tools.ts` (route execute through consent)
- Test: `tests/consent.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // contract.ts
  export const CONSENT_RENDERER_ID = "mcp-consent";
  export const consentPayloadSchema = z.object({
    serverName: z.string(),
    toolName: z.string(),
    summary: z.string(),          // truncated argument preview
    destructive: z.boolean(),
  });
  export const consentResponseSchema = z.object({
    decision: z.enum(["once", "thread", "deny"]),
  });
  // consent.ts
  export interface ConsentGate {
    /** Resolves true when the call may proceed. */
    check(tool: CatalogTool, args: Record<string, unknown>,
          ctx: PluginAgentToolContext): Promise<{ allowed: true } | { allowed: false; reason: string }>;
    forgetThread(threadId: string): void;
  }
  export function createConsentGate(deps: {
    requestInput: BbPluginApi["ui"]["requestInput"];
    serverName(serverId: string): string;
    timeoutMs?: number;   // default 120_000
  }): ConsentGate;
  ```

**Three constraints this must respect:**
1. A thread holds at most one pending interaction. Concurrent tool calls in one
   turn must queue behind a per-thread mutex, and the decision cache must be
   consulted *after* the queue so a "thread" decision granted by the first
   prompt covers the second without asking again.
2. A foreign interaction (Claude's own question, a permission prompt) can hold
   the slot, so `requestInput` may throw. Catch it and return a retryable
   refusal rather than failing the turn.
3. Consent and the MCP call share one `execute()` against a ~5 minute transport
   ceiling. Use `timeoutMs` 120000 here and 90000 for the call.

- [ ] **Step 1: Write the failing test**

```ts
// tests/consent.test.ts
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CONSENT_RENDERER_ID } from "../contract.js";
import plugin from "../server.js";

let host: ReturnType<typeof createFakePluginHost> | null = null;
afterEach(async () => { await host?.harness.lifecycle.dispose(); host = null; });

async function setup() {
  host = createFakePluginHost({ pluginId: "mcp" });
  await plugin(host.bb);
  await host.harness.behavior.callRpc("servers_add", {
    displayName: "Echo", transport: "stdio",
    command: process.execPath, args: ["tests/fixtures/echo-mcp-server.mjs"],
  });
  await host.harness.behavior.callRpc("catalog_sync", { serverId: "echo" });
  await host.harness.behavior.callRpc("tool_set_ask", {
    serverId: "echo", upstreamName: "echo", ask: true,
  });
  return host;
}

describe("consent gate", () => {
  it("prompts before a write and proceeds when allowed", async () => {
    const active = await setup();
    const call = active.harness.behavior.callAgentTool("echo", { text: "hi" });
    await vi.waitFor(() => expect(active.harness.inspection.pendingInteractions).toHaveLength(1));
    const [pending] = active.harness.inspection.pendingInteractions;
    expect(pending.rendererId).toBe(CONSENT_RENDERER_ID);
    active.harness.behavior.submitInteraction(pending.id, { decision: "once" });
    const result = await call;
    expect(JSON.stringify(result)).toContain("hi");
  });

  it("returns an error result when the user denies", async () => {
    const active = await setup();
    const call = active.harness.behavior.callAgentTool("echo", { text: "hi" });
    await vi.waitFor(() => expect(active.harness.inspection.pendingInteractions).toHaveLength(1));
    active.harness.behavior.cancelInteraction(
      active.harness.inspection.pendingInteractions[0].id,
    );
    expect(JSON.stringify(await call)).toMatch(/declined|cancelled/i);
  });

  it("asks once when the user allows for the thread", async () => {
    const active = await setup();
    const first = active.harness.behavior.callAgentTool("echo", { text: "a" });
    await vi.waitFor(() => expect(active.harness.inspection.pendingInteractions).toHaveLength(1));
    active.harness.behavior.submitInteraction(
      active.harness.inspection.pendingInteractions[0].id, { decision: "thread" },
    );
    await first;
    await active.harness.behavior.callAgentTool("echo", { text: "b" });
    expect(active.harness.inspection.pendingInteractions).toHaveLength(0);
  });

  it("does not prompt for a readOnly tool", async () => {
    const active = await setup();
    await active.harness.behavior.callRpc("tool_set_ask", {
      serverId: "echo", upstreamName: "echo", ask: false,
    });
    await active.harness.behavior.callAgentTool("echo", { text: "x" });
    expect(active.harness.inspection.pendingInteractions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/consent.test.ts`
Expected: FAIL, consent module missing.

- [ ] **Step 3: Implement the gate**

Keep `Map<string, Promise<void>>` for the per-thread mutex and
`Map<string, Set<string>>` for thread-scoped allowances. `check` returns
immediately when `tool.ask` is false. Otherwise it chains onto the thread's
mutex, re-checks the allowance set, then calls `requestInput` with a summary
built from `JSON.stringify(args)` truncated to 800 characters. A `submitted`
result with `decision: "thread"` records the allowance; `"once"` allows just
this call; `"deny"` and every `cancelled` outcome refuse. Wrap `requestInput`
in try/catch and refuse with a retry hint when it throws.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/consent.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/consent.ts contract.ts src/server/tools.ts tests/consent.test.ts
git commit -m "Gate write tools behind a consent prompt

BB puts every plugin tool in Claude Code's allowedTools and Codex forwards
tool calls with no approval hook, so no provider will ask on our behalf. A
thread holds one interaction at a time and both Claude and Codex emit parallel
tool calls, so prompts queue on a per-thread mutex and the decision cache is
read after the queue."
```

---

## Task 8: OAuth for remote servers

**Files:**
- Create: `src/oauth/pkce.ts`, `src/oauth/discovery.ts`, `src/oauth/flow.ts`,
  `src/storage/oauth-store.ts`, `src/server/routes.ts`
- Test: `tests/oauth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function createPkce(): { verifier: string; challenge: string; state: string };
  export interface AuthServerMetadata {
    authorizationEndpoint: string; tokenEndpoint: string;
    registrationEndpoint: string | null;
  }
  export function discover(resourceUrl: string): Promise<AuthServerMetadata>;
  export function registerClient(
    metadata: AuthServerMetadata, redirectUri: string,
  ): Promise<{ clientId: string; clientSecret: string | null }>;
  export interface OAuthFlow {
    begin(serverId: string, resourceUrl: string): Promise<{ authorizeUrl: string }>;
    complete(state: string, code: string): Promise<{ serverId: string }>;
    accessToken(serverId: string): Promise<string | null>;   // refreshes when near expiry
  }
  ```

**Rules:** the callback route must use `auth: "none"` because a browser
redirect from Notion carries neither a BB origin nor a plugin token; the
single-use `state` nonce with a 10 minute TTL is its only protection, and it
must live in SQLite so a BB restart mid-flow does not strand the callback.
Refresh at 75 percent of `expires_in` measured from local receipt time, never
from an absolute `exp`, and single-flight the refresh. Retry a 401 once after
refresh only when `tool.readOnly` is true; never auto-retry a write. Read
`bb.server.loopbackBaseUrl` inside the handler, never at factory scope.
Notion and Slack support Dynamic Client Registration; Gmail does not, so read
`googleClientId` / `googleClientSecret` from secret settings and skip
registration.

- [ ] **Step 1: Write the failing test**

```ts
// tests/oauth.test.ts
import { describe, expect, it, vi } from "vitest";
import { createPkce } from "../src/oauth/pkce.js";
import { createOAuthFlow } from "../src/oauth/flow.js";
import { createOAuthStore } from "../src/storage/oauth-store.js";
import Database from "better-sqlite3";
import { MCP_MIGRATIONS } from "../src/storage/schema.js";

function store() {
  const db = new Database(":memory:");
  for (const statement of MCP_MIGRATIONS) db.exec(statement);
  return createOAuthStore(db);
}

describe("pkce", () => {
  it("produces a distinct verifier, challenge and state each time", () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).not.toEqual(b.verifier);
    expect(a.challenge).not.toEqual(a.verifier);
    expect(a.state).toHaveLength(43);
  });
});

describe("oauth flow", () => {
  const metadata = {
    authorizationEndpoint: "https://as.example/authorize",
    tokenEndpoint: "https://as.example/token",
    registrationEndpoint: "https://as.example/register",
  };

  it("survives a restart between begin and complete", async () => {
    const shared = store();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/register")) {
        return new Response(JSON.stringify({ client_id: "cid" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        access_token: "at", refresh_token: "rt", expires_in: 3600,
      }), { status: 200 });
    });
    const begun = createOAuthFlow({
      store: shared, discover: async () => metadata, fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    const { authorizeUrl } = await begun.begin("notion", "https://mcp.notion.com/mcp");
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    expect(new URL(authorizeUrl).searchParams.get("code_challenge_method")).toBe("S256");

    // A second flow object over the same store stands in for a restarted server.
    const restarted = createOAuthFlow({
      store: shared, discover: async () => metadata, fetchImpl,
      redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    expect(await restarted.complete(state, "code")).toEqual({ serverId: "notion" });
    expect(await restarted.accessToken("notion")).toBe("at");
  });

  it("rejects an unknown or replayed state", async () => {
    const flow = createOAuthFlow({
      store: store(), discover: async () => metadata,
      fetchImpl: vi.fn(), redirectUri: () => "http://127.0.0.1:38886/cb",
    });
    await expect(flow.complete("nope", "code")).rejects.toThrow(/state/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/oauth.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement PKCE, discovery, flow, store and route**

`createPkce` uses `randomBytes(32)` base64url for the verifier and state, and
`createHash("sha256")` base64url for the challenge. `discover` fetches
`/.well-known/oauth-protected-resource` then
`/.well-known/oauth-authorization-server`, falling back to conventional
endpoint paths. `createOAuthFlow.begin` persists
`(state, verifier, serverId, expiresAt)` and returns the authorize URL with
`response_type=code`, `code_challenge_method=S256`. `complete` loads and
deletes the pending row, rejects when absent or expired, exchanges the code,
and stores tokens with `obtainedAt`. `accessToken` refreshes when
`Date.now() > obtainedAt + expiresIn * 0.75 * 1000`, single-flighted per
server.

`src/server/routes.ts` registers
`bb.http.route("GET", "/oauth/callback", handler, { auth: "none" })` and
returns a small HTML page telling the user to return to BB.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/oauth.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/oauth src/storage/oauth-store.ts src/server/routes.ts tests/oauth.test.ts
git commit -m "Add OAuth for remote MCP servers

The callback route must be unauthenticated because a browser redirect carries
no BB origin or plugin token, so the single-use state nonce is its only
protection and it lives in SQLite to survive a restart mid-flow. Refresh is
scheduled from local receipt time because an absolute exp is unreliable
against clock skew."
```

---

## Task 9: RPC contract, connections panel, consent renderer

**Files:**
- Modify: `contract.ts`, `app.tsx`
- Create: `src/server/rpc.ts`, `src/ui/connections-panel.tsx`, `src/ui/consent-prompt.tsx`
- Test: `tests/rpc.test.ts`

**RPC methods:** `servers_list`, `servers_add`, `servers_remove`,
`servers_connect` (returns `authorizeUrl` for http servers),
`servers_test` (spawn/connect and return the stderr tail),
`catalog_sync`, `tools_list`, `tool_set_ask`,
`bindings_list`, `binding_set`, `projects_list`.

Every input is a zod object; never send a key with an `undefined` value from
the frontend. Publish `bb.realtime.publish("mcp-changed", ...)` after every
mutation and refetch in the panel, including when
`useRealtimeConnectionState` goes reconnecting to connected, because signals
are not replayed.

- [ ] **Step 1: Write the failing test**

```ts
// tests/rpc.test.ts
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server.js";

let host: ReturnType<typeof createFakePluginHost> | null = null;
afterEach(async () => { await host?.harness.lifecycle.dispose(); host = null; });

describe("rpc", () => {
  it("adds, lists and removes a server", async () => {
    host = createFakePluginHost({ pluginId: "mcp" });
    await plugin(host.bb);
    const added = await host.harness.behavior.callRpc("servers_add", {
      displayName: "Echo", transport: "stdio",
      command: process.execPath, args: ["tests/fixtures/echo-mcp-server.mjs"],
    });
    expect(added.server.id).toBe("echo");
    expect((await host.harness.behavior.callRpc("servers_list", null)).servers)
      .toHaveLength(1);
    await host.harness.behavior.callRpc("servers_remove", { id: "echo" });
    expect((await host.harness.behavior.callRpc("servers_list", null)).servers)
      .toEqual([]);
  });

  it("reports a failing stdio server with its stderr tail", async () => {
    host = createFakePluginHost({ pluginId: "mcp" });
    await plugin(host.bb);
    await host.harness.behavior.callRpc("servers_add", {
      displayName: "Broken", transport: "stdio",
      command: process.execPath, args: ["tests/fixtures/does-not-exist.mjs"],
    });
    const result = await host.harness.behavior.callRpc("servers_test", { id: "broken" });
    expect(result.ok).toBe(false);
    expect(result.stderr.join("\n")).toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/rpc.test.ts`
Expected: FAIL, RPC methods missing.

- [ ] **Step 3: Implement RPC and the two UI surfaces**

`src/server/rpc.ts` registers the contract against the registry, catalog, pool
and oauth flow. `servers_add` derives the slug from `displayName`
(lowercase, non-alphanumeric to `-`).

`src/ui/connections-panel.tsx` is a `navPanel` component: outer
`h-full min-h-0 overflow-y-auto p-4 md:p-5`, inner
`mx-auto w-full max-w-3xl`, a single `h-8` toolbar row with the primary action
`ml-auto`. Server rows show status, tool count, a Connect button for http
servers that opens `authorizeUrl`, and a Test button for stdio servers that
shows the stderr tail. Below, a per-project tool table with an enable checkbox
and an "ask" checkbox per tool. Import every control from
`@/components/ui/<name>`.

`src/ui/consent-prompt.tsx` renders `PluginPendingInteractionProps`: parse
`interaction.payload` with `consentPayloadSchema`, show server, tool and the
truncated argument summary, and offer Allow once / Allow for this thread /
Deny wired to `submit({ decision })` and `cancel()`.

`app.tsx` registers both:

```tsx
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "mcp", title: "MCP", icon: "PlugSocket", path: "mcp",
    component: ConnectionsPanel,
  });
  app.slots.pendingInteraction({
    id: CONSENT_RENDERER_ID, component: ConsentPrompt,
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/rpc.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add contract.ts app.tsx src/server/rpc.ts src/ui tests/rpc.test.ts
git commit -m "Add the connections panel and consent renderer

The Test button surfaces the child's stderr tail, which is the diagnostic
Claude Code hides when an npx or docker MCP server fails to start."
```

---

## Task 10: Compose, supervise, install

**Files:**
- Modify: `server.ts`, `package.json` (scripts)
- Create: `src/server/services.ts`, `eslint.config.js`, `vitest.config.ts`,
  `skills/mcp/SKILL.md`, `README.md`
- Test: `tests/lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lifecycle.test.ts
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server.js";

describe("lifecycle", () => {
  it("loads with no servers and disposes cleanly", async () => {
    const host = createFakePluginHost({ pluginId: "mcp" });
    await plugin(host.bb);
    await expect(host.harness.lifecycle.dispose()).resolves.not.toThrow();
  });

  it("survives a reload against the same database", async () => {
    const host = createFakePluginHost({ pluginId: "mcp" });
    await plugin(host.bb);
    await host.harness.behavior.callRpc("servers_add", {
      displayName: "Echo", transport: "stdio",
      command: process.execPath, args: ["tests/fixtures/echo-mcp-server.mjs"],
    });
    const reloaded = await host.harness.lifecycle.reload(plugin);
    const listed = await reloaded.harness.behavior.callRpc("servers_list", null);
    expect(listed.servers).toHaveLength(1);
    await reloaded.harness.lifecycle.dispose();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- tests/lifecycle.test.ts`
Expected: FAIL.

- [ ] **Step 3: Compose `server.ts` and add the services**

`server.ts` is wiring only: open the database, run `MCP_MIGRATIONS`, build the
registry, oauth store, stdio supervisor, client pool, catalog, consent gate,
then call `registerCatalogTools`, `registerConfigure`, `registerRpc`,
`registerRoutes`, `registerCli`, and register services. Finally:

```ts
bb.onDispose(async () => {
  await pool.closeAll();
  await stdio.killAll();
});
```

`src/server/services.ts` adds
`bb.background.schedule("catalog-refresh", "*/17 * * * *", ...)` for catalog
sync and `bb.background.service("token-refresh", ...)` with an abort-aware
sleep for OAuth refresh. A plain `setTimeout` that ignores the abort signal
makes the plugin report "degraded (service did not stop)" on reload.

Add `eslint.config.js` ignoring `.worktrees/**`, `**/dist/**`,
`**/node_modules/**`, `**/coverage/**`, `components/**`, `lib/**`, and
`vitest.config.ts` with the `@` alias to the repo root plus
`test.exclude` extending `configDefaults.exclude` with `**/.worktrees/**`.
Add scripts: `"test": "vitest run"`, `"lint": "eslint ."`,
`"build": "bb plugin build"`,
`"verify": "npm run lint && npm test && npm run build"`.
Add `.worktrees/` and `coverage/` to `.gitignore`.

Write `skills/mcp/SKILL.md` telling agents that MCP tools appear as ordinary
tools, that write tools prompt, and that `bb mcp` lists servers. Add
`bb.skills: ["skills"]` to the manifest.

- [ ] **Step 4: Run the full gate**

Run: `npm run verify`
Expected: lint clean, all tests pass, `bb plugin build` writes
`dist/server.js`, `dist/app.js`, `dist/app.css`.

- [ ] **Step 5: Install and smoke-test live**

```bash
cd /Users/vojtadrbohlav/dev/bb-plugin-mcp
bb plugin install . --yes
bb plugin reload mcp
bb plugin logs mcp -n 50
```

Add the user's three existing stdio servers through the panel and press Test on
each. Expect `chrome-devtools` (`npx -y chrome-devtools-mcp@latest`) to resolve
once the login-shell PATH is applied.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Wire the plugin together and add the verify gate

Dispose closes MCP clients and kills stdio children; dispose hooks run before
BB drains in-flight invocations, so this is the only place that reliably
reaps them."
```

---

## Self-review notes

- Spec sections 5 (naming), 6 (registration lifecycle), 6b (stdio), 7
  (consent), 8 (per-project selection), 9 (OAuth), 10 (error handling) and 11
  (testing) each map to a task above. Section 8b (cost control) is realised by
  Task 6's per-project selection plus Task 9's tool table; the token-estimate
  display is deferred per spec section 13.
- Deferred by the spec and deliberately absent here: per-resolution schema
  pruning, naming override modes, multiple accounts per server, host-side
  stdio, MCP resources/prompts/sampling/elicitation.
- Type consistency: `ServerRecord`, `CatalogTool`, `Registry`, `ClientPool`,
  `DiscoveredTool`, `Catalog`, `ConsentGate`, `OAuthFlow` are defined once in
  the task that creates them and referenced by exact name afterwards.
