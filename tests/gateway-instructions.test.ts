// What an agent is told about a gateway without anyone writing it down.
//
// A gateway contributes a few tools that reach a much larger set the catalog
// never sees, and the services behind it are named only inside one tool's
// description - which a provider may never put in front of the model. Claude
// Code lists a plugin tool by name and loads its description on a keyword
// search that matches whole words, so an agent asked about Notion searches,
// finds nothing, and reports that nothing offers Notion while `execute` sits
// in its own tool list.
import { describe, expect, it } from "vitest";
import { buildInstructions, MAX_INSTRUCTIONS } from "../src/server/configure.js";
import { describeReach } from "../src/server/gateway.js";
import type { CatalogTool } from "../src/storage/registry.js";

function tool(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return {
    serverId: "executor", upstreamName: "execute", registeredName: "execute",
    description: "Run code.\n\n## Available integrations\n- `notion_com`\n- `slack_com`\n",
    inputSchema: {}, readOnly: false, ask: true, askOverridden: false,
    defaultEnabled: true, stale: false, syncedAt: 1, ...overrides,
  };
}

describe("gateway instructions", () => {
  it("names the services behind a gateway as words", () => {
    const text = buildInstructions([tool()]);
    expect(text).toContain("notion");
    expect(text).toContain("slack");
    expect(text).toContain("execute");
  });

  it("tells the agent to load the tool by exact name", () => {
    // The load-bearing sentence: a keyword search for "notion" is not a hit
    // for a tool called `execute`, so searching is not how this gets found.
    expect(buildInstructions([tool()])).toContain("select:mcp__bb-bridge__execute");
  });

  it("says nothing when no gateway is configured", () => {
    // An ordinary MCP server needs no explaining, and instructions cost every
    // turn of every thread.
    expect(buildInstructions([tool({ description: "Search Notion pages." })])).toBe("");
  });

  it("ignores a stale row", () => {
    expect(buildInstructions([tool({ stale: true })])).toBe("");
  });

  it("stays inside the host's truncation limit", () => {
    const many = Array.from({ length: 40 }, (_, index) => tool({
      registeredName: `tool_${index}`,
      upstreamName: `tool_${index}`,
      description: `Run code.\n${Array.from({ length: 40 }, (_, n) =>
        `- \`service_${index}_${n}_com\``).join("\n")}\n`,
    }));
    expect(buildInstructions(many).length).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
  });
});

/**
 * A Cloudflare MCP portal, which hides its upstreams differently.
 *
 * Executor names its integrations inside one tool's description. A portal
 * forwards each upstream server's tools under that server's id - or, in code
 * mode, replaces all of them with two `portal_codemode_*` tools that name
 * nothing at all. The second case is the one where the honest answer is "ask
 * it" rather than "here is the list".
 */
describe("what a cloudflare portal reaches", () => {
  const codeMode = [
    { upstreamName: "portal_codemode_search", description: "Search available tools." },
    { upstreamName: "portal_codemode_execute", description: "Execute tool calls." },
    { upstreamName: "portal_list_servers", description: "Lists all available upstream MCP servers." },
  ];

  it("reads the upstream servers off namespaced tool names", () => {
    // `<serverId>_<originalName>`, split on the first underscore - which is
    // why Cloudflare forbids underscores in a server id.
    expect(describeReach([
      { upstreamName: "github_list_issues", description: "" },
      { upstreamName: "github_create_issue", description: "" },
      { upstreamName: "notion_search", description: "" },
      { upstreamName: "portal_list_servers", description: "" },
    ]).services).toEqual(["github", "notion"]);
  });

  it("names a tool to call when code mode hides them all", () => {
    expect(describeReach(codeMode)).toEqual({
      services: [],
      discoverWith: "portal_list_servers",
    });
  });

  it("tells an agent to ask rather than to conclude", () => {
    const text = buildInstructions(codeMode.map((entry, index) => tool({
      serverId: "portal", registeredName: entry.upstreamName,
      upstreamName: entry.upstreamName, description: entry.description,
      syncedAt: index,
    })));
    expect(text).toContain("portal_list_servers");
    expect(text).toMatch(/before saying a service is/i);
  });

  it("has nothing to say about a server that hides nothing", () => {
    expect(describeReach([
      { upstreamName: "search", description: "Search Notion pages." },
    ])).toEqual({ services: [], discoverWith: null });
  });
});
