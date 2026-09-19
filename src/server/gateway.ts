// What a server reaches beyond the tools it actually contributes.
//
// A gateway contributes a few tools that reach a much larger set this catalog
// never sees, and the panel, `bb mcp list`, the agent instructions and the
// registered tool description all have to say the same thing about it. So
// there is exactly one function here that answers the question -
// `describeReach` - and every surface takes the part of its answer it needs.
// The alternative, which this file used to be, was three callers each parsing
// descriptions their own way: the CLI printed `notion_com` while the panel
// printed `notion`, about the same server, on the same screen.
//
// Two shapes hide their contents differently, and a user should not have to
// know which they have:
//
//   Executor names its integrations inside one tool's description, as a
//   bullet list of slugs:
//
//       ## Available integrations
//       - `notion_com`
//       - `slack_com`
//
//   A Cloudflare portal forwards each upstream server's tools namespaced
//   `<serverId>_<name>`, so the ids are in the tool names themselves - unless
//   it runs in code mode, where `portal_codemode_*` replaces all of them and
//   nothing static names the upstreams at all. Then the only honest answer is
//   a tool to call.
//
// Why the slugs become words: a provider may defer a plugin tool to a
// name-only entry and load its description only when the model searches for
// it, and that search matches whole words. A query for "notion" is not a hit
// for `notion_com`, so an agent asked to read a Notion page is told nothing
// matched - with `execute` in its tool list the whole time.

/** A bullet whose entire content is one backticked identifier. */
const INTEGRATION_BULLET = /^\s*[-*]\s+`([A-Za-z0-9][A-Za-z0-9._-]*)`\s*$/;

/**
 * Trailing segments that name where a service lives rather than the service.
 * Only ever dropped from the end, and never the last segment standing.
 */
const TRAILING_NOISE = new Set(["com", "io", "org", "net", "co", "ai", "dev", "app"]);

/** Enough for any real gateway, and a bound on what a bad description can add. */
const MAX_INTEGRATIONS = 40;

/**
 * Tools a portal contributes about ITSELF rather than about anything upstream.
 * Cloudflare uses `portal` as the prefix for its own, so it is also a server
 * id no upstream can have.
 */
const PORTAL_PREFIX = "portal";

/** The tool that answers "what is behind this portal" at runtime. */
const PORTAL_LIST_SERVERS = "portal_list_servers";

/** `notion_com` -> `notion`; `notion_private_mcp` -> `notion private mcp`. */
export function integrationWords(identifier: string): string {
  const segments = identifier.split(/[_.-]+/).filter((segment) => segment !== "");
  while (segments.length > 1 && TRAILING_NOISE.has(segments[segments.length - 1].toLowerCase())) {
    segments.pop();
  }
  return segments.join(" ");
}

/**
 * The services one tool's DESCRIPTION names, as words.
 *
 * Deliberately narrow: it reads one markdown shape - a bullet list of bare
 * identifiers - and not prose. Harvesting every identifier in a description
 * would pull in `queryOptions` and `getNextPageParam` from any tool that
 * documents an API, which is noise in the description and noise in the
 * search. An ordinary tool yields nothing, which is the right answer.
 */
function describedServices(description: string): string[] {
  const services: string[] = [];
  const seen = new Set<string>();
  for (const line of description.split("\n")) {
    const match = INTEGRATION_BULLET.exec(line);
    if (!match) continue;
    const words = integrationWords(match[1]);
    const key = words.toLowerCase();
    if (words === "" || seen.has(key)) continue;
    seen.add(key);
    services.push(words);
    if (services.length === MAX_INTEGRATIONS) break;
  }
  return services;
}

/**
 * The upstream server ids a portal's tool NAMES give away.
 *
 * Split on the FIRST underscore, which is why Cloudflare forbids underscores
 * in a server id. Empty for a portal in code mode.
 */
function namedServices(upstreamNames: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of upstreamNames) {
    const separator = name.indexOf("_");
    if (separator <= 0) continue;
    const id = name.slice(0, separator);
    if (id === PORTAL_PREFIX || found.includes(id)) continue;
    found.push(id);
    if (found.length === MAX_INTEGRATIONS) break;
  }
  return found.map(integrationWords);
}

/** One tool, as much of it as reach depends on. */
export interface ReachTool {
  registeredName: string;
  upstreamName: string;
  description: string;
}

/** What a server reaches beyond the tools it actually contributes. */
export interface ServerReach {
  /**
   * Tools whose own description names what they reach, and what each names.
   *
   * Only description-derived, never name-derived: a portal's
   * `github_list_issues` already carries "github" in its name, and appending
   * "Reaches: github" to it would spend tokens repeating the name back.
   */
  doors: Array<{ registeredName: string; services: string[] }>;
  /** Everything reached, from both shapes, deduplicated and sorted. */
  services: string[];
  /**
   * A tool to call when nothing static names them, `null` when there is
   * nothing more to find out. A portal in code mode is the case this exists
   * for: its two tools reach every upstream server and name none of them.
   */
  discoverWith: string | null;
}

/**
 * Everything one server's catalog says about what it reaches.
 *
 * The single source for every surface. Pass one tool to ask about that tool,
 * a server's whole catalog to ask about the server.
 */
export function describeReach(tools: readonly ReachTool[]): ServerReach {
  const doors: Array<{ registeredName: string; services: string[] }> = [];
  const services = new Set<string>();
  for (const tool of tools) {
    const described = describedServices(tool.description);
    if (described.length === 0) continue;
    doors.push({ registeredName: tool.registeredName, services: described });
    for (const service of described) services.add(service);
  }
  for (const service of namedServices(tools.map((tool) => tool.upstreamName))) {
    services.add(service);
  }
  return {
    doors,
    services: [...services].sort(),
    discoverWith: services.size === 0
      && tools.some((tool) => tool.upstreamName === PORTAL_LIST_SERVERS)
      ? PORTAL_LIST_SERVERS
      : null,
  };
}
