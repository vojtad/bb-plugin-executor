import type { BbPluginApi, PluginAgentToolContext, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { integrations } from "./executor.js";
import type { ExecutorTool } from "./storage/store.js";

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
 * unregister or update, so a tool whose description moves (adding an
 * integration rewrites `execute`'s) keeps the old one until a reload.
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
  return JSON.stringify([description(tool), tool.inputSchema]);
}

/**
 * A provider that defers tools may only load a description on a keyword
 * search, which will never match "notion" against a tool named `execute`, so
 * the integrations are repeated as plain words.
 */
function description(tool: ExecutorTool): string {
  if (tool.name !== "execute") return tool.description;
  const reaches = integrations([tool]);
  return reaches.length === 0 ? tool.description : `${tool.description}\n\nReaches: ${reaches.join(", ")}.`;
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
        name: tool.name,
        description: description(tool),
        parameters: tool.inputSchema,
        presentation: {
          label: { pending: label("Running ", tool.name), completed: label("Ran ", tool.name) },
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

export function instructions(tools: readonly ExecutorTool[]): string {
  if (!tools.some((tool) => tool.name === "execute")) return "";
  const reaches = integrations(tools);
  const text = [
    "Executor's `execute` tool reaches services that are not in your tool list under their own names"
    + (reaches.length === 0 ? "." : `: ${reaches.join(", ")}.`)
    + " Check it before telling anyone a service is unavailable.",
    "Load it by its exact name rather than searching for the service - in Claude Code, "
    + "`ToolSearch` with `select:execute`, where the name may carry your provider's prefix "
    + "for BB tools, e.g. `select:mcp__bb-bridge__execute`.",
    "Executor actions that need approval are approved by the user or their auto-approve "
    + "rules, never by you. A declined or cancelled approval means the user said no: do not "
    + "retry it without asking them.",
  ].join("\n\n");
  return text.slice(0, MAX_INSTRUCTIONS);
}

export function registerConfigure(bb: BbPluginApi, tools: () => readonly ExecutorTool[]): void {
  bb.agents.configure(() => {
    const current = tools();
    const names = registeredFor(bb);
    const text = instructions(current);
    return {
      tools: current.filter((tool) => names.has(tool.name)).map((tool) => tool.name),
      skills: [],
      ...(text === "" ? {} : { instructions: text }),
    };
  });
}
