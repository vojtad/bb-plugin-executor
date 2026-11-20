import type { PluginAgentToolContentPart } from "@get-bb/plugin-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { toBbContent } from "./mcp/content.js";
import { flattenSchema, RecursiveSchemaError } from "./mcp/schema-tools.js";
import { isUnauthorized } from "./oauth/flow.js";
import type { ExecutorTool } from "./storage/store.js";

/**
 * How long one call may run, approval prompts included. BB's tool-call round
 * trip gives up near five minutes, so this stays under it.
 */
export const CALL_TIMEOUT_MS = 270_000;

/**
 * The URL to talk to: native elicitation, so approvals come to this plugin
 * instead of to the model (v1 and v2 both read the query parameter; v2 also
 * preselects it on its OAuth consent page). A URL that already names a mode
 * is left alone.
 */
export function endpointUrl(url: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("elicitation_mode")) {
    parsed.searchParams.set("elicitation_mode", "native");
  }
  return parsed.toString();
}

/** v2 replaced v1's artifact tools with `call`, `search` and `describe`. */
export function detectVersion(tools: readonly { name: string }[]): "v1" | "v2" | null {
  if (tools.length === 0) return null;
  return tools.some((tool) => tool.name === "call") ? "v2" : "v1";
}

export function integrations(tools: readonly ExecutorTool[]): string[] {
  const execute = tools.find((tool) => tool.name === "execute");
  if (!execute) return [];
  const section = /## Available integrations([\s\S]*?)(?:\n#|$)/.exec(execute.description)?.[1] ?? "";
  return [...section.matchAll(/^- `([^`]+)`/gm)]
    .map((match) => match[1].replace(/_com$/, "").replace(/_/g, " "));
}

export type Elicit = (params: ElicitRequest["params"]) => Promise<ElicitResult>;

export interface ExecutorClient {
  listTools(): Promise<ExecutorTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; elicit: Elicit },
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
      return fetch(input, { ...init, headers });
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

/**
 * A fresh MCP session per operation. It costs one `initialize` round trip,
 * and buys an elicitation handler bound to exactly one tool call - and so to
 * the thread whose user must answer it.
 */
export function createExecutorClient(deps: ExecutorClientDeps): ExecutorClient {
  const createTransport = deps.createTransport ?? httpTransport;

  async function session<T>(elicit: Elicit | null, run: (client: Client) => Promise<T>): Promise<T> {
    const url = deps.url();
    if (url === null) throw new Error("No Executor URL is configured.");
    const client = new Client(
      { name: "bb-plugin-executor", version: "0.2.0" },
      { capabilities: elicit === null ? {} : { elicitation: { form: {} } } },
    );
    if (elicit !== null) {
      client.setRequestHandler(ElicitRequestSchema, (request) => elicit(request.params));
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
  async function withAuthRetry<T>(elicit: Elicit | null, run: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await session(elicit, run);
    } catch (error) {
      if (!isUnauthorized(error) || !(await deps.refreshAuth())) throw error;
      return session(elicit, run);
    }
  }

  return {
    listTools: () => withAuthRetry(null, async (client) => {
      const { tools } = await client.listTools();
      const usable: ExecutorTool[] = [];
      for (const tool of tools) {
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

    callTool: (name, args, { signal, elicit }) => withAuthRetry(elicit, async (client) => {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: CALL_TIMEOUT_MS,
      });
      return {
        content: toBbContent(result.content, result.structuredContent),
        isError: result.isError === true,
      };
    }),
  };
}
