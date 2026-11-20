import type { PluginAgentToolContentPart } from "@get-bb/plugin-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Pending, pendingInteraction, type Response } from "./approvals.js";
import { toBbContent } from "./mcp/content.js";
import { flattenSchema, RecursiveSchemaError } from "./mcp/schema-tools.js";
import { isUnauthorized } from "./oauth/flow.js";
import { createHash } from "node:crypto";
import type { AppUpdate, ExecutorApp } from "../contract.js";
import type { ExecutorTool } from "./storage/store.js";

/** How long one request may run. BB's tool-call round trip gives up near five minutes. */
export const CALL_TIMEOUT_MS = 270_000;

/**
 * The URL as given, validated. Executor reads the approval mode from it for an
 * API key (the plain /mcp URL is model mode, its default and the only one where
 * the plugin decides) and from the consent page for a sign-in.
 */
export function endpointUrl(url: string): string {
  return new URL(url).toString();
}

const ACCESS_REFUSED = "Cloudflare Access refused the request. Save an Access service token "
  + "that the application's Service Auth policy allows, and check its client ID and secret.";

/**
 * `fetch` that refuses to follow Cloudflare Access to its login page. Followed,
 * the redirect ends in an HTML page that surfaces as an unreadable content-type
 * or JSON error instead of saying what is in the way.
 */
export const fetchExecutor: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "manual" });
  if (response.status < 300 || response.status >= 400) return response;
  const location = response.headers.get("location") ?? "";
  if (/^https:\/\/[^/]+\.cloudflareaccess\.com\//.test(location)) throw new Error(ACCESS_REFUSED);
  return fetch(input, init);
};

/** The plugin answers pauses itself; the agent never sees this tool. */
export const RESUME_TOOL = "resume";

export interface ExecutorClient {
  listTools(): Promise<ExecutorTool[]>;
  /** The approval mode Executor applies to this credential, or null when it does not say. */
  approvalMode(): Promise<string | null>;
  /** Each app against its catalog entry and the framework version the server runs. */
  checkUpdates(): Promise<{ framework: string | null; apps: AppUpdate[] }>;
  /** The apps installed in Executor, with their linked accounts, and the organization slug. */
  listApps(): Promise<{ apps: ExecutorApp[]; organization: string | null }>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; decide: (pending: Pending) => Promise<Response> },
  ): Promise<{ content: PluginAgentToolContentPart[]; isError: boolean }>;
}

export interface ExecutorClientDeps {
  url(): string | null;
  authHeaders(): Promise<Record<string, string>>;
  refreshAuth(): Promise<boolean>;
  createTransport?(url: string, authHeaders: () => Promise<Record<string, string>>): Transport;
}

function httpTransport(url: string, authHeaders: () => Promise<Record<string, string>>): Transport {
  return new StreamableHTTPClientTransport(new URL(url), {
    // Resolved per request, so a token refreshed mid-call is picked up.
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(await authHeaders())) headers.set(name, value);
      const response = await fetchExecutor(input, { ...init, headers });
      // Executor never answers MCP with a page; Access does when it refuses.
      if (response.headers.get("content-type")?.startsWith("text/html")) throw new Error(ACCESS_REFUSED);
      return response;
    },
  });
}

/** Puts the HTTP status into the SDK's often empty "Error POSTing to endpoint:" message. */
function describeFailure(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error;
  const { code } = error as { code?: unknown };
  if (typeof code !== "number" || code < 400 || code >= 600) return error;
  const detail = (error instanceof Error ? error.message : "")
    .replace(/^Streamable HTTP error: /, "")
    .replace(/^Error POSTing to endpoint: /, "")
    .trim()
    .slice(0, 200);
  return Object.assign(
    new Error(`Executor answered HTTP ${code}${detail === "" ? "" : `: ${detail}`}`),
    { code, status: code, cause: error },
  );
}

/** A fresh MCP session per operation, so no pooled session can go stale. */
export function createExecutorClient(deps: ExecutorClientDeps): ExecutorClient {
  const createTransport = deps.createTransport ?? httpTransport;

  async function session<T>(
    run: (client: Client) => Promise<T>,
    decide?: (pending: Pending) => Promise<Response>,
  ): Promise<T> {
    const url = deps.url();
    if (url === null) throw new Error("No Executor URL is configured.");
    const client = new Client(
      { name: "bb-plugin-executor", version: "0.3.0" },
      { capabilities: decide === undefined ? {} : { elicitation: { form: {} } } },
    );
    if (decide !== undefined) {
      // Native mode asks over MCP instead of pausing, and names only the
      // app-local tool, so no rule can match: the user always answers.
      client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
        if (params.mode === "url") return { action: "decline" };
        const { action, content } = await decide({
          requestId: "",
          tool: null,
          source: "Executor",
          message: params.message,
          requestedSchema: params.requestedSchema,
          approvalUrl: null,
        });
        return content === undefined ? { action } : { action, content };
      });
    }
    try {
      await client.connect(createTransport(endpointUrl(url), () => deps.authHeaders()));
      return await run(client);
    } catch (error) {
      throw describeFailure(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** A 401 is refused before anything runs, so one refresh and retry is safe even for a write. */
  async function withAuthRetry<T>(
    run: (client: Client) => Promise<T>,
    decide?: (pending: Pending) => Promise<Response>,
  ): Promise<T> {
    try {
      return await session(run, decide);
    } catch (error) {
      if (!isUnauthorized(error) || !(await deps.refreshAuth())) throw error;
      return session(run, decide);
    }
  }

  return {
    listTools: () => withAuthRetry(async (client) => {
      const { tools } = await client.listTools();
      const usable: ExecutorTool[] = [];
      for (const tool of tools) {
        if (tool.name === RESUME_TOOL) continue;
        try {
          usable.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: flattenSchema(tool.inputSchema),
          });
        } catch (error) {
          if (!(error instanceof RecursiveSchemaError)) throw error;
        }
      }
      return usable;
    }),

    approvalMode: async () => {
      const url = deps.url();
      if (url === null) return null;
      const response = await fetchExecutor(new URL("/mcp/whoami", url), { headers: await deps.authHeaders() });
      if (!response.ok) return null;
      const body: unknown = await response.json().catch(() => null);
      return isRecord(body) && typeof body.mode === "string" ? body.mode : null;
    },

    checkUpdates: () => withAuthRetry(async (client) => {
      const [release, list] = await callExecutorTools(client, [
        { path: "tools.executor.framework.release", input: {} },
        { path: "tools.executor.appManagement.list", input: {} },
      ]);
      // Executor keeps its own app current; there is nothing to compare it with.
      const apps = (Array.isArray(list) ? list.filter(isRecord) : []).filter((app) => app.slug !== "executor");
      const sources = await callExecutorTools(client, apps.map((app) => ({
        path: "tools.executor.appManagement.source",
        input: { path: { app: app.id } },
      })));
      const updates = await Promise.all(apps.map(async (app, index) => {
        const source = sources[index];
        const files = isRecord(source) && Array.isArray(source.files) ? source.files.filter(isRecord) : [];
        const reference = isRecord(app.copiedFrom) ? app.copiedFrom.reference : null;
        const catalog = typeof reference === "string" && reference.startsWith("https://catalog.executor.sh/")
          ? await fetch(reference).then((response) => response.json()).catch(() => null) as unknown
          : null;
        const catalogFiles = isRecord(catalog) && Array.isArray(catalog.files) ? catalog.files.filter(isRecord) : null;
        return {
          id: String(app.id),
          catalogChanges: catalogFiles === null ? null : changedFiles(files, catalogFiles),
          framework: declaredFramework(files),
        };
      }));
      return {
        framework: isRecord(release) && typeof release.version === "string" ? release.version : null,
        apps: updates,
      };
    }),

    listApps: () => withAuthRetry(async (client) => {
      const [context, list] = await callExecutorTools(client, [
        { path: "tools.executor.context.get", input: {} },
        { path: "tools.executor.appManagement.list", input: {} },
      ]);
      const apps = Array.isArray(list) ? list.filter(isRecord) : [];
      const linked = await callExecutorTools(client, apps.flatMap((app) => [
        { path: "tools.executor.appAccounts.userList", input: { path: { app: app.id } } },
        { path: "tools.executor.appAccounts.appList", input: { path: { app: app.id } } },
      ]));
      return {
        organization: isRecord(context) && typeof context.slug === "string" ? context.slug : null,
        apps: apps.map((app, index) => {
          const links = [linked[index * 2], linked[index * 2 + 1]]
            .flatMap((value) => (Array.isArray(value) ? value.filter(isRecord) : []));
          const requirements = isRecord(app.requirements) && isRecord(app.requirements.accounts)
            ? Object.keys(app.requirements.accounts)
            : [];
          return {
            id: String(app.id),
            slug: String(app.slug),
            name: String(app.name),
            accounts: links.map((link) => ({
              label: isRecord(link.account) ? String(link.account.label) : String(link.requirement),
              signIn: isRecord(link.signIn) ? String(link.signIn.state) : "unknown",
            })),
            missing: requirements.filter((name) => !links.some((link) => link.requirement === name)),
          };
        }),
      };
    }),

    callTool: (name, args, { signal, decide }) => withAuthRetry(async (client) => {
      const call = (tool: string, input: Record<string, unknown>) =>
        client.callTool({ name: tool, arguments: input }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
      let result = await call(name, args);
      for (let pending = pendingInteraction(result.structuredContent); pending !== null;
        pending = pendingInteraction(result.structuredContent)) {
        const response = await decide(pending);
        if (pending.approvalUrl === null) {
          result = await call(RESUME_TOOL, { requestId: pending.requestId, response });
        } else if (response.action === "accept") {
          // Browser mode: the answer was given on Executor's page; resume collects it.
          result = await call(RESUME_TOOL, { requestId: pending.requestId });
        } else {
          return {
            content: [{ type: "text", text: "The user did not answer Executor's approval page, so the call did not continue." }],
            isError: true,
          };
        }
      }
      return {
        content: toBbContent(result.content, result.structuredContent),
        isError: result.isError === true,
      };
    }, decide),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Runs Executor's own tools through `call`; each result is its value, or null when it failed. */
async function callExecutorTools(
  client: Client,
  calls: { path: string; input: unknown }[],
): Promise<unknown[]> {
  if (calls.length === 0) return [];
  const result = await client.callTool({ name: "call", arguments: { calls } }, undefined, { timeout: CALL_TIMEOUT_MS });
  const execution = isRecord(result.structuredContent) ? result.structuredContent.execution : null;
  const values = isRecord(execution) && Array.isArray(execution.value) ? execution.value : [];
  return calls.map((_, index) => {
    const entry: unknown = values[index];
    return isRecord(entry) && entry.ok === true ? entry.value : null;
  });
}

type SourceFile = Record<string, unknown>;

function fileBytes(file: SourceFile): Buffer {
  const content = typeof file.content === "string" ? file.content : "";
  return Buffer.from(content, file.encoding === "base64" ? "base64" : "utf8");
}

/** Git's blob id, so a file Executor returns only by object id compares with one returned whole. */
function blobId(file: SourceFile): string {
  if (typeof file.object === "string") return file.object;
  const bytes = fileBytes(file);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function changedFiles(mine: SourceFile[], theirs: SourceFile[]): number {
  const ids = (files: SourceFile[]) => new Map(files.map((file) => [String(file.path), blobId(file)]));
  const a = ids(mine);
  const b = ids(theirs);
  return [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).length;
}

function declaredFramework(files: SourceFile[]): string | null {
  const manifest = files.find((file) => file.path === "package.json" && typeof file.content === "string");
  if (manifest === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(fileBytes(manifest).toString("utf8"));
    const dependencies = isRecord(parsed) && isRecord(parsed.dependencies) ? parsed.dependencies : {};
    return typeof dependencies.apps === "string" ? dependencies.apps : null;
  } catch {
    return null;
  }
}
