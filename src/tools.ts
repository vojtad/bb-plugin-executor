import type { BbPluginApi, PluginAgentToolContext, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import type { Connection, ExecutorTool } from "./storage/store.js";

export type RunTool = (
  name: string,
  args: Record<string, unknown>,
  ctx: PluginAgentToolContext,
) => Promise<PluginAgentToolResult>;

/** BB rejects a registration whose row label is longer than this. */
const LABEL_MAX_CHARS = 80;
const MAX_INSTRUCTIONS = 4096;

/**
 * name -> the shape handed to `registerTool`, per plugin load. There is no
 * unregister or update, so a tool whose description moves (an Executor
 * upgrade) keeps the old one until a reload.
 */
const registered = new WeakMap<BbPluginApi, Map<string, string>>();

function registeredFor(bb: BbPluginApi): Map<string, string> {
  let names = registered.get(bb);
  if (!names) {
    names = new Map();
    registered.set(bb, names);
  }
  return names;
}

function shape(tool: ExecutorTool): string {
  return JSON.stringify([tool.description, tool.inputSchema]);
}

/**
 * `executor_search`, not `search`: a bare name collides with other plugins'
 * tools, and an agent searching its deferred tools for "executor" finds these.
 */
export function registeredName(upstream: string): string {
  return `executor_${upstream}`;
}

function label(prefix: string, name: string): string {
  const text = `${prefix}${name}`;
  return text.length <= LABEL_MAX_CHARS ? text : `${text.slice(0, LABEL_MAX_CHARS - 3)}...`;
}

/** Registers every cached tool not registered yet; safe to call after each sync. */
export function registerTools(bb: BbPluginApi, tools: readonly ExecutorTool[], run: RunTool): void {
  const names = registeredFor(bb);
  for (const tool of tools) {
    if (names.has(tool.name)) continue;
    try {
      bb.agents.registerTool({
        name: registeredName(tool.name),
        description: tool.description,
        parameters: tool.inputSchema,
        presentation: {
          label: { pending: label("Executor: ", tool.name), completed: label("Executor: ", tool.name) },
        },
        execute: (params, ctx) => run(
          tool.name,
          typeof params === "object" && params !== null && !Array.isArray(params)
            ? params as Record<string, unknown>
            : {},
          ctx,
        ),
      });
      names.set(tool.name, shape(tool));
    } catch (error) {
      bb.log.warn(`Could not register Executor tool "${tool.name}": ${String(error)}`);
    }
  }
}

export function changedTools(bb: BbPluginApi, tools: readonly ExecutorTool[]): string[] {
  const names = registeredFor(bb);
  return tools
    .filter((tool) => names.has(tool.name) && names.get(tool.name) !== shape(tool))
    .map((tool) => tool.name);
}

export function instructions(connection: Pick<Connection, "url" | "error" | "tools" | "apps">): string {
  if (connection.url === null) return "";
  const apps = connection.apps
    .filter((app) => app.slug !== "executor")
    .map((app) => `${app.name} (\`${app.slug}\`)`);
  if (connection.tools.length === 0) {
    return "The user's integrations"
      + (apps.length === 0 ? "" : ` (${apps.join(", ")})`)
      + " come through Executor, which is not reachable right now"
      + (connection.error === null ? "" : `: ${connection.error}`)
      + ". Tell the user to fix it in BB's Executor panel; `bb executor status` shows the state.";
  }
  return [
    "Executor connects the user's integrations"
    + (apps.length === 0 ? "" : `: ${apps.join(", ")}`)
    + ". They are not in your tool list under their own names; reach them through the "
    + "`executor_*` tools. Check Executor before telling anyone a service is unavailable.",
    "Use `executor_search` to find a tool's exact path, `executor_describe` for its signature, "
    + "and `executor_call` (or `executor_execute` for a program) to run it. BB does not show you "
    + "Executor's own server instructions, so read them once with "
    + "`executor_skills({ app: \"executor\", name: \"executor\" })` before first use. If your "
    + "client defers tools, load them by exact name - in Claude Code, `ToolSearch` with "
    + "`select:mcp__bb-bridge__executor_search,mcp__bb-bridge__executor_call`.",
    "Executor actions that need approval are approved by the user or their auto-approve "
    + "rules, never by you. A declined or cancelled approval means the user said no: do not "
    + "retry it without asking them.",
  ].join("\n\n").slice(0, MAX_INSTRUCTIONS);
}

/** Instructions are rebuilt per session, so a newly connected app reaches new threads without a reload. */
export function registerConfigure(
  bb: BbPluginApi,
  connection: () => Pick<Connection, "url" | "error" | "tools" | "apps">,
): void {
  bb.agents.configure(() => {
    const current = connection();
    const names = registeredFor(bb);
    const text = instructions(current);
    return {
      tools: current.tools.filter((tool) => names.has(tool.name)).map((tool) => registeredName(tool.name)),
      skills: [],
      ...(text === "" ? {} : { instructions: text }),
    };
  });
}
