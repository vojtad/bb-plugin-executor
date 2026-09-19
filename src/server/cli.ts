// `bb mcp` - the read-only view of what is configured.
//
// It exists for agents more than for people. BB renders a registered CLI
// command into the plugin-commands skill without executing plugin code, so an
// agent that wonders which MCP tools it has can answer the question from a
// shell instead of guessing from tool names. Everything that CHANGES a server
// stays in the panel: adding one means typing a command line or starting an
// OAuth flow, and neither belongs to an agent.
import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import type { Registry } from "../storage/registry.js";
import { describeReach } from "./gateway.js";
import { driftedToolNames } from "./tools.js";

export interface CliDeps {
  registry: Registry;
}

function describe(bb: BbPluginApi, registry: Registry): string {
  const servers = registry.listServers();
  if (servers.length === 0) {
    return "No MCP servers are configured. Open the MCP panel in BB to add one.\n";
  }
  const lines: string[] = [];
  let anyDefault = false;
  let anyDrifted = false;
  let anyAsk = false;
  for (const server of servers) {
    const target = server.transport === "stdio"
      ? [server.command, ...server.args].join(" ")
      : (server.url ?? "");
    const tools = registry.listTools(server.id);
    const live = tools.filter((tool) => !tool.stale);
    const drifted = driftedToolNames(bb, live);
    lines.push(
      `${server.id}  ${server.displayName}  [${server.kind}]`
      + `${server.enabled ? "" : " (disabled)"}`,
    );
    lines.push(`  ${target}`);
    // Above the tool list, not below it: an agent reading this to find out
    // why a call failed needs the reason before the inventory, and every tool
    // named underneath is unusable until someone reconnects the server.
    if (server.authError !== null) {
      lines.push(`  ! NEEDS RECONNECTING in the MCP panel: ${server.authError}`);
    } else if (server.syncError !== null) {
      // The tools printed below came from the cache, and saying so is the
      // whole point: an agent reading this list would otherwise take them for
      // a live inventory.
      lines.push(`  ! NOT RESPONDING - tools below are cached: ${server.syncError}`);
    }
    lines.push(
      live.length === 0
        // Named per transport: Test only exists for a local server, and a
        // remote one - which is what is usually in this state - would be sent
        // looking for a button that is not on its row.
        ? `  no tools discovered yet - open this server's Settings in the MCP `
          + `panel and press Sync tools${server.transport === "http"
            ? ", or Connect if it has never been signed in to" : ""}`
        : `  ${live.length} tool(s): `
          + live.map((tool) =>
            `${tool.registeredName}${tool.defaultEnabled ? "*" : ""}`
            + `${tool.ask ? "?" : ""}`
            + `${drifted.has(tool.registeredName) ? "!" : ""}`).join(", "),
    );
    // A gateway tool's name says nothing about what it reaches. An agent sent
    // here to find out whether it can touch Notion has to be able to read the
    // answer off this list - in the same words the panel uses, from the same
    // function, or the two disagree in front of the same user.
    const reach = describeReach(live);
    for (const door of reach.doors) {
      lines.push(`  ${door.registeredName} reaches: ${door.services.join(", ")}`);
    }
    // A portal names its upstreams in the tool names rather than in any one
    // description, so it has services but no door to attribute them to.
    if (reach.doors.length === 0 && reach.services.length > 0) {
      lines.push(`  reaches: ${reach.services.join(", ")}`);
    }
    if (reach.discoverWith !== null) {
      lines.push(
        `  reaches servers this catalog cannot see - run ${reach.discoverWith} to list them`,
      );
    }
    anyDefault ||= live.some((tool) => tool.defaultEnabled);
    anyAsk ||= live.some((tool) => tool.ask);
    anyDrifted ||= drifted.size > 0;
  }
  // Without this an agent that finds itself holding a tool no project ever
  // bound has no way to learn where it came from.
  if (anyDefault) {
    lines.push("* on by default in every project that has not switched it off");
  }
  // The one fact an agent planning a sequence of calls most needs from this
  // list, and the only one it could not get: which of them stop and wait for
  // a human.
  if (anyAsk) {
    lines.push("? asks the user before it runs, and waits for their answer");
  }
  // An agent holding a tool whose description no longer matches the catalog
  // has no other way to find out, and the answer is never "sync again".
  if (anyDrifted) {
    lines.push(
      "! changed since it was registered - run `bb plugin reload mcp` to "
      + "update what the model is shown",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function registerCli(bb: BbPluginApi, deps: CliDeps): void {
  bb.cli.register({
    name: "mcp",
    summary: "List the configured MCP servers and the tools they contribute.",
    commands: [
      { name: "list", summary: "List configured MCP servers and their tools.", usage: "bb mcp list" },
    ],
    run(argv: string[]): PluginCliResult {
      // `bb mcp` and `bb mcp list` are the same thing; anything else is a
      // typo worth naming rather than silently treating as a list.
      const [command] = argv;
      if (command !== undefined && command !== "list") {
        return { exitCode: 1, stderr: `Unknown command "${command}". Usage: bb mcp list\n` };
      }
      return { exitCode: 0, stdout: describe(bb, deps.registry) };
    },
  });
}
