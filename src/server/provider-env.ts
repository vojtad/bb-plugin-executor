// Turns off Claude Code's claude.ai connectors, so integrations come through
// Executor only: twelve connectors cost ~188k prompt tokens per session.
// Servers in ~/.claude.json still load, and Codex has no equivalent switch
// (set `[features] apps = false` in ~/.codex/config.toml by hand).
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export function registerProviderEnv(bb: BbPluginApi): void {
  bb.providers.experimental_contributeEnv("claude-code", () => [
    {
      name: "ENABLE_CLAUDEAI_MCP_SERVERS",
      value: "0",
      reason: "Integrations come from the Executor plugin, so claude.ai connectors are off",
    },
  ]);
  bb.providers.experimental_contributeEnvHealth("claude-code", () => ({
    label: "Integrations via Executor",
    statusMessage: "claude.ai connectors are not loaded; integrations come from the Executor plugin.",
  }));
}
