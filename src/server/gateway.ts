// Reading the services a gateway tool reaches out of its own description.
//
// A gateway server contributes a few tools that reach a much larger set this
// catalog never sees, and the only place the services behind it are named is
// the gateway tool's description - as slugs, in a bullet list:
//
//     ## Available integrations
//     - `notion_com`
//     - `slack_com`
//
// A provider may not show the model that description at all. Claude Code
// defers a plugin tool to a name-only entry and loads the description when
// the model searches for it, and that search matches whole tokens: a query
// for "notion" is not a hit for `notion_com`. So an agent asked to read a
// Notion page searches, is told nothing matched, and reports that no MCP
// server offers Notion - with `execute` in its tool list the whole time.
//
// Splitting those slugs into words is the whole of the fix. It puts "notion"
// in the description as a word the search can find, and it gives `bb mcp` a
// list to print, so the shell route answers the question too.

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
 * The identifiers a gateway tool's description lists, in the order it lists
 * them.
 *
 * Deliberately narrow: it reads one markdown shape - a bullet list of bare
 * identifiers - and not prose. Harvesting every identifier in a description
 * would pull in `queryOptions` and `getNextPageParam` from any tool that
 * documents an API, which is noise in the description and noise in the
 * search. An ordinary tool yields nothing here, which is the right answer.
 */
export function gatewayIntegrations(description: string): string[] {
  const found: string[] = [];
  for (const line of description.split("\n")) {
    const match = INTEGRATION_BULLET.exec(line);
    if (!match) continue;
    const identifier = match[1];
    if (!found.includes(identifier)) found.push(identifier);
    if (found.length === MAX_INTEGRATIONS) break;
  }
  return found;
}

/** `notion_com` -> `notion`; `notion_private_mcp` -> `notion private mcp`. */
export function integrationWords(identifier: string): string {
  const segments = identifier.split(/[_.-]+/).filter((segment) => segment !== "");
  while (segments.length > 1 && TRAILING_NOISE.has(segments[segments.length - 1].toLowerCase())) {
    segments.pop();
  }
  return segments.join(" ");
}

/**
 * The services a gateway description names, as words, deduplicated.
 *
 * Empty for a tool that lists nothing, and callers append nothing in that
 * case rather than a line that says none.
 */
export function integrationSearchTerms(description: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const identifier of gatewayIntegrations(description)) {
    const words = integrationWords(identifier);
    const key = words.toLowerCase();
    if (words === "" || seen.has(key)) continue;
    seen.add(key);
    terms.push(words);
  }
  return terms;
}


/**
 * Tools a portal contributes about ITSELF rather than about anything upstream.
 * Cloudflare namespaces every upstream tool `<serverId>_<name>` and uses
 * `portal` as the prefix for its own, so this is also a reserved server id.
 */
const PORTAL_PREFIX = "portal";

/** The tool that answers "what is behind this portal" at runtime. */
const PORTAL_LIST_SERVERS = "portal_list_servers";

/**
 * The upstream server ids a Cloudflare MCP portal's own tool NAMES give away.
 *
 * A portal exposes each upstream server's tools namespaced as
 * `<serverId>_<originalName>`, split on the FIRST underscore - which is why
 * Cloudflare forbids underscores in a server id. So a portal that exposes its
 * upstreams directly names them in every tool it contributes, and no
 * description has to be parsed to find them.
 *
 * Empty for a portal in code mode, where the upstream tools are replaced
 * wholesale by `portal_codemode_*` and nothing static names them at all.
 */
export function portalUpstreamIds(upstreamNames: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of upstreamNames) {
    const separator = name.indexOf("_");
    if (separator <= 0) continue;
    const id = name.slice(0, separator);
    if (id === PORTAL_PREFIX || found.includes(id)) continue;
    found.push(id);
    if (found.length === MAX_INTEGRATIONS) break;
  }
  return found;
}

/** What a server reaches beyond the tools it actually contributes. */
export interface ServerReach {
  /** The services it reaches, as words, deduplicated and sorted. */
  services: string[];
  /**
   * A tool to call when the services cannot be read statically, `null` when
   * there is nothing more to find out.
   *
   * A Cloudflare portal in code mode is the case this exists for: its two
   * `portal_codemode_*` tools reach every upstream server and name none of
   * them, so the only way to learn what is behind it is to ask it.
   */
  discoverWith: string | null;
}

/**
 * Everything one server's catalog says about what it reaches.
 *
 * Covers both shapes a gateway takes, because a user should not have to know
 * which they have: an Executor-style server that lists its integrations as
 * slugs inside one tool's description, and a Cloudflare portal that puts each
 * upstream server id in front of every tool name it forwards.
 */
export function describeReach(
  tools: ReadonlyArray<{ upstreamName: string; description: string }>,
): ServerReach {
  const services = new Set<string>();
  for (const tool of tools) {
    for (const term of integrationSearchTerms(tool.description)) services.add(term);
  }
  for (const id of portalUpstreamIds(tools.map((tool) => tool.upstreamName))) {
    services.add(integrationWords(id));
  }
  const names = new Set(tools.map((tool) => tool.upstreamName));
  return {
    services: [...services].sort(),
    discoverWith: services.size === 0 && names.has(PORTAL_LIST_SERVERS)
      ? PORTAL_LIST_SERVERS
      : null,
  };
}
