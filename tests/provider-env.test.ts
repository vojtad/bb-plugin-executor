import type { ExperimentalPluginProviderEnvContext } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server.js";

const context: ExperimentalPluginProviderEnvContext = {
  threadId: "t1",
  projectId: "proj_a",
  hostId: "h1",
};

let host: ReturnType<typeof createFakePluginHost> | null = null;
afterEach(async () => { await host?.harness.lifecycle.dispose(); host = null; });

async function load(): Promise<ReturnType<typeof createFakePluginHost>> {
  host = createFakePluginHost({ pluginId: "executor" });
  await plugin(host.bb);
  return host;
}

describe("provider environment", () => {
  // No server configured, on purpose: the contribution is about what the
  // provider must not load, which does not depend on what this plugin has.
  it("turns claude.ai connectors off for Claude Code", async () => {
    const active = await load();

    expect(await active.harness.behavior.resolveProviderEnv("claude-code", context))
      .toEqual([
        expect.objectContaining({
          name: "ENABLE_CLAUDEAI_MCP_SERVERS",
          value: "0",
        }),
      ]);
  });

  // Codex has no environment variable for this, and BB maps contributed env
  // to `shell_environment_policy.set.*` - the environment for shell commands
  // the agent runs, not the codex process - so an entry here would do
  // nothing. It is switched off in `~/.codex/config.toml` instead.
  it("contributes nothing to Codex", async () => {
    const active = await load();

    expect(await active.harness.behavior.resolveProviderEnv("codex", context)).toEqual([]);
  });
});
