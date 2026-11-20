// bb-plugin-executor - connects one Executor v2 server to BB.
//
// Tools are registered from the cached catalog, so the load path never waits
// on the server. When an Executor action pauses for approval, this plugin
// answers it from the user's rules or a BB prompt - never the model.
import type { BbPluginApi, PluginAgentToolContext, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { EXECUTOR_CHANGED, type ExecutorState, rpcContract } from "./contract.js";
import { createApprovals } from "./src/approvals.js";
import { createExecutorClient, endpointUrl, fetchExecutor } from "./src/executor.js";
import { discoverWith } from "./src/oauth/discovery.js";
import { createOAuthFlow, isUnauthorized } from "./src/oauth/flow.js";
import { quietLogger, warnQuietly } from "./src/server/log.js";
import { registerProviderEnv } from "./src/server/provider-env.js";
import { oauthRedirectUri, registerOAuthRoutes } from "./src/server/routes.js";
import { createOAuthStore } from "./src/storage/oauth-store.js";
import { createStore, MIGRATIONS } from "./src/storage/store.js";
import { changedTools, registerConfigure, registerTools } from "./src/tools.js";

/** The OAuth store is keyed by server; there is only ever this one. */
const SERVER_ID = "executor";
const SYNC_CRON = "*/17 * * * *";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const database = bb.storage.database();
  bb.storage.migrate(database, MIGRATIONS);
  const store = createStore(database);
  // Background work outlives the load, and a stale `bb` throws on any member.
  const log = quietLogger(bb);
  const changed = (): void => {
    try {
      bb.realtime.publish(EXECUTOR_CHANGED, null);
    } catch {
      // A stale handle after a reload; nobody is listening to this load anymore.
    }
  };

  const oauth = createOAuthFlow({
    store: createOAuthStore(database),
    discover: (url) => discoverWith(fetchExecutor, url),
    fetchImpl: fetchExecutor,
    redirectUri: (origin) => oauthRedirectUri(bb, origin),
    onAuthFailure: (_serverId, message) => {
      store.setError(`Sign-in expired: ${message}`);
      warnQuietly(bb, `Executor needs reconnecting: ${message}`);
      changed();
    },
    onAuthRecovered: () => { store.setError(null); changed(); },
    log,
  });

  const client = createExecutorClient({
    url: () => store.get().url,
    authHeaders: async (): Promise<Record<string, string>> => {
      const { url, token } = store.get();
      if (token) return { Authorization: `Bearer ${token}` };
      const access = url === null ? null : await oauth.accessToken(SERVER_ID, endpointUrl(url));
      return access ? { Authorization: `Bearer ${access}` } : {};
    },
    refreshAuth: async () => (store.get().token ? false : oauth.refresh(SERVER_ID)),
  });

  const approvals = createApprovals({
    requestInput: (request, options) => bb.ui.requestInput(request, options),
    approveAll: () => store.get().approveAll,
    rules: () => store.rules(),
    addRule: (pattern) => { store.addRule(pattern); changed(); },
  });

  const runTool = async (
    name: string,
    args: Record<string, unknown>,
    ctx: PluginAgentToolContext,
  ): Promise<PluginAgentToolResult> => {
    try {
      return await client.callTool(name, args, {
        signal: ctx.signal,
        decide: (pending) => approvals.answer(pending, ctx),
      });
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Executor could not run "${name}": ${String(error)}. `
            + "If it was cut off mid-run, earlier calls in it may already have taken effect.",
        }],
        isError: true,
      };
    }
  };

  async function sync(): Promise<void> {
    if (store.get().url === null) return;
    try {
      store.setTools(await client.listTools());
      registerTools(bb, store.get().tools, runTool);
    } catch (error) {
      // Not signed in yet is a state the panel already shows, not a failure.
      const signedOut = !store.get().token && oauth.status(SERVER_ID) === "disconnected";
      if (!(signedOut && isUnauthorized(error))) {
        store.setError(`Could not read tools: ${error instanceof Error ? error.message : String(error)}`);
      }
      log.warn(`Executor sync failed, keeping the cached tools: ${String(error)}`);
    }
    changed();
  }

  registerTools(bb, store.get().tools, runTool);
  registerConfigure(bb, () => store.get().tools);
  registerProviderEnv(bb);
  registerOAuthRoutes(bb, { flow: oauth, onConnected: () => { void sync(); } });
  bb.background.schedule("sync", SYNC_CRON, sync);

  function state(): ExecutorState {
    const connection = store.get();
    return {
      url: connection.url,
      hasToken: connection.token !== null,
      auth: connection.token !== null ? "connected" : oauth.status(SERVER_ID),
      error: connection.error,
      syncedAt: connection.syncedAt,
      tools: connection.tools.map((tool) => tool.name),
      changedTools: changedTools(bb, connection.tools),
      approveAll: connection.approveAll,
      rules: store.rules(),
    };
  }

  const done = { ok: true as const };
  const mutate = (apply: () => void): typeof done => {
    apply();
    changed();
    return done;
  };

  bb.rpc.register(rpcContract, {
    state: () => state(),
    configure: async ({ url, token }) => {
      const trimmed = url.trim();
      endpointUrl(trimmed); // Throws on a malformed URL.
      const current = store.get();
      const nextToken = token === null ? current.token : token.trim() || null;
      if (trimmed !== current.url) oauth.forget(SERVER_ID);
      store.setTarget(trimmed, nextToken);
      changed();
      await sync();
      return done;
    },
    connect: async ({ redirectOrigin }) => {
      const { url } = store.get();
      if (url === null) throw new Error("Save the Executor URL first.");
      return oauth.begin(SERVER_ID, endpointUrl(url), redirectOrigin);
    },
    oauth_complete: async ({ state: oauthState, code }) => {
      await oauth.complete(oauthState, code);
      store.setError(null);
      await sync();
      return done;
    },
    disconnect: () => mutate(() => {
      oauth.forget(SERVER_ID);
      store.setTarget(null, null);
    }),
    sync: async () => { await sync(); return done; },
    reload: () => {
      // After the reply: a reload disposes the instance answering it.
      setTimeout(() => { void bb.sdk.plugins.reload({ pluginId: bb.pluginId }).catch(() => undefined); }, 0);
      return done;
    },
    set_approve_all: ({ enabled }) => mutate(() => { store.setApproveAll(enabled); }),
    add_rule: ({ pattern }) => mutate(() => {
      const trimmed = pattern.trim();
      if (trimmed === "" || trimmed === "*") throw new Error("Use Approve all instead of a bare *.");
      store.addRule(trimmed);
    }),
    delete_rule: ({ pattern }) => mutate(() => { store.deleteRule(pattern); }),
  });

  bb.cli.register({
    name: "executor",
    summary: "Show the Executor connection, its tools, and the auto-approve rules.",
    commands: [{ name: "status", summary: "Show the connection and rules.", usage: "bb executor status" }],
    run(argv) {
      if (argv[0] !== undefined && argv[0] !== "status") {
        return { exitCode: 1, stderr: `Unknown command "${argv[0]}". Usage: bb executor status\n` };
      }
      const s = state();
      if (s.url === null) return { exitCode: 0, stdout: "Executor is not configured. Open the Executor panel in BB.\n" };
      const lines = [
        `${s.url}  ${s.auth}`,
        ...(s.error === null ? [] : [`! ${s.error}`]),
        `tools: ${s.tools.join(", ") || "none yet"}`,
        `auto-approve: ${s.approveAll ? "everything" : s.rules.join(", ") || "nothing"}`,
      ];
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });
}
