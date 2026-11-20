import type { PluginAgentToolContentPart } from "@get-bb/plugin-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Pending, pendingInteraction, type Response } from "./approvals.js";
import { toBbContent } from "./mcp/content.js";
import { flattenSchema, RecursiveSchemaError } from "./mcp/schema-tools.js";
import { isUnauthorized } from "./oauth/flow.js";
import type { ExecutorTool } from "./storage/store.js";

/** How long one request may run. BB's tool-call round trip gives up near five minutes. */
export const CALL_TIMEOUT_MS = 270_000;

/**
 * The URL to talk to, always in model mode: a paused call comes back as a
 * result this plugin answers through `resume`. Native mode would skip approval
 * for `call` entirely (it trusts the client to have confirmed it, and BB does
 * not), and automatic mode approves everything. Executor reads the mode per
 * request for an access token, and preselects it on its OAuth consent page.
 */
export function endpointUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("elicitation_mode", "model");
  return parsed.toString();
}

/**
 * `fetch` that refuses to follow Cloudflare Access to its login page. Followed,
 * the redirect ends in an HTML page that surfaces as an unreadable content-type
 * or JSON error instead of saying what is in the way.
 */
export const fetchExecutor: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: "manual" });
  if (response.status < 300 || response.status >= 400) return response;
  const location = response.headers.get("location") ?? "";
  if (/^https:\/\/[^/]+\.cloudflareaccess\.com\//.test(location)) {
    throw new Error(
      "Cloudflare Access sent this request to its login page. Executor only accepts its own "
      + "tokens, so Access has to let /mcp, /.well-known/ and /api/auth/oauth2/ through "
      + "(a Bypass policy for those paths).",
    );
  }
  return fetch(input, init);
};

/** The plugin answers pauses itself; the agent never sees this tool. */
export const RESUME_TOOL = "resume";

export interface ExecutorClient {
  listTools(): Promise<ExecutorTool[]>;
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
      return fetchExecutor(input, { ...init, headers });
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

  async function session<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const url = deps.url();
    if (url === null) throw new Error("No Executor URL is configured.");
    const client = new Client({ name: "bb-plugin-executor", version: "0.3.0" });
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
  async function withAuthRetry<T>(run: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await session(run);
    } catch (error) {
      if (!isUnauthorized(error) || !(await deps.refreshAuth())) throw error;
      return session(run);
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

    callTool: (name, args, { signal, decide }) => withAuthRetry(async (client) => {
      const call = (tool: string, input: Record<string, unknown>) =>
        client.callTool({ name: tool, arguments: input }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
      let result = await call(name, args);
      for (let pending = pendingInteraction(result.structuredContent); pending !== null;
        pending = pendingInteraction(result.structuredContent)) {
        const response = await decide(pending);
        result = await call(RESUME_TOOL, { requestId: pending.requestId, response });
      }
      return {
        content: toBbContent(result.content, result.structuredContent),
        isError: result.isError === true,
      };
    }),
  };
}
