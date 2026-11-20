import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  EXECUTOR_CHANGED,
  type AppUpdate,
  type ExecutorRpcContract,
  type ExecutorState,
  OAUTH_CALLBACK_SUBPATH,
  PLUGIN_ID,
} from "../../contract.js";

/** OAuth codes already sent, so StrictMode's double effect cannot spend one twice. */
const exchanged = new Set<string>();

function Disclosure(props: { title: string; summary: string; children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-start gap-2"
        aria-expanded={open}
        onClick={() => { setOpen(!open); }}
      >
        <span className="text-foreground">{props.title}</span>
        <span className="text-xs font-normal text-muted-foreground">{props.summary}</span>
      </Button>
      {open ? props.children : null}
    </div>
  );
}

const MODE_NOTES: Record<string, string> = {
  model: "Executor is in model mode: your rules decide, and anything else is a prompt in the thread.",
  automatic: "Executor is in automatic mode and approves actions itself, so these rules are not used. "
    + "Questions a tool asks still come to the thread.",
  native: "Executor is in native mode: it doesn't say which app an approval is for, so every approval "
    + "is a prompt and these rules are not used. executor_call runs without any approval in this mode.",
  browser: "Executor is in browser mode: approvals happen on Executor's page, linked from the prompt in "
    + "the thread, so these rules are not used.",
};

function updateText(update: AppUpdate | undefined, framework: string | null): string | null {
  if (update === undefined) return null;
  const parts: string[] = [];
  if (update.catalogChanges === 0) parts.push("matches the catalog");
  else if (update.catalogChanges !== null) {
    parts.push(`${update.catalogChanges} file${update.catalogChanges === 1 ? "" : "s"} differ from the catalog`);
  }
  if (update.framework !== null && framework !== null && update.framework !== framework) {
    parts.push(`built for ${update.framework}, server runs ${framework}`);
  }
  return parts.length === 0 ? "up to date" : parts.join("; ");
}

function statusText(state: ExecutorState): string {
  if (state.url === null) return "Not set up";
  if (state.error !== null) return "Needs attention";
  if (state.auth === "needs-reconnect") return "Sign-in expired";
  if (state.auth === "disconnected") return "Not signed in";
  return "Connected";
}

export function ExecutorPanel(props: { subPath?: string }): ReactElement {
  const rpc = useRpc<ExecutorRpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const navigate = useBbNavigate();

  const [state, setState] = useState<ExecutorState | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [cfClientId, setCfClientId] = useState("");
  const [cfClientSecret, setCfClientSecret] = useState("");
  const [rule, setRule] = useState("");
  const [updates, setUpdates] = useState<{ framework: string | null; apps: AppUpdate[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(() => {
    void rpcRef.current.call("state", null).then((next) => {
      setState(next);
      setUrl((current) => (current === "" ? next.url ?? "" : current));
    });
  }, []);
  useEffect(load, [load]);
  useRealtime(EXECUTOR_CHANGED, load);

  const run = async (action: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      if (done !== undefined) setMessage({ text: done, error: false });
    } catch (cause) {
      setMessage({ text: String(cause), error: true });
    } finally {
      setBusy(false);
      load();
    }
  };

  useEffect(() => {
    if (props.subPath !== OAUTH_CALLBACK_SUBPATH) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const oauthState = params.get("state");
    const failure = params.get("error_description") ?? params.get("error");
    if (failure === null && (code === null || oauthState === null)) return;
    navigate.toPluginPanel(PLUGIN_ID, { replace: true });
    if (failure !== null) {
      setMessage({ text: `Sign-in failed: ${failure}`, error: true });
      return;
    }
    if (exchanged.has(oauthState as string)) return;
    exchanged.add(oauthState as string);
    void run(
      () => rpcRef.current.call("oauth_complete", { state: oauthState as string, code: code as string }),
      "Signed in.",
    );
  }, [props.subPath]);

  if (state === null) return <div className="p-5 text-sm text-muted-foreground">Loading</div>;

  const connect = (): void => {
    void run(async () => {
      const { authorizeUrl } = await rpcRef.current.call("connect", {
        redirectOrigin: window.location.origin,
      });
      navigate.openUrl(authorizeUrl);
    });
  };

  /** null keeps a stored secret, "" removes it. */
  const save = (
    fields: { token: string | null; cfClientId: string | null; cfClientSecret: string | null },
    done = "Saved.",
  ): void => {
    void run(() => rpcRef.current.call("configure", { url, ...fields }), done);
  };
  const typed = (value: string): string | null => (value === "" ? null : value);
  const signedIn = state.hasToken || state.auth === "connected";

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-medium text-foreground">Executor</h1>
            <span className="text-xs text-muted-foreground">{statusText(state)}</span>
            {state.dashboardUrl !== null ? (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => { navigate.openUrl(state.dashboardUrl as string); }}
              >
                Open dashboard
              </Button>
            ) : null}
          </div>

          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              save({ token: typed(token), cfClientId: typed(cfClientId), cfClientSecret: typed(cfClientSecret) });
              setToken("");
              setCfClientId("");
              setCfClientSecret("");
            }}
          >
            <Label htmlFor="executor-url">MCP URL</Label>
            <Input
              id="executor-url"
              value={url}
              placeholder="https://executor.example.com/mcp"
              onChange={(event) => { setUrl(event.target.value); }}
            />

            <Disclosure
              title="Cloudflare Access"
              summary={state.hasServiceToken ? "Service token saved" : "Only if Access protects Executor"}
            >
              <p className="text-xs text-muted-foreground">
                In Cloudflare Zero Trust, create a service token, then add a Service Auth policy
                that allows it to the Executor application. Keep your own Allow policy too: you
                still sign in through Access in the browser.
              </p>
              <div className="flex gap-2">
                <Input
                  aria-label="Cloudflare Access client ID"
                  type="password"
                  value={cfClientId}
                  placeholder={state.hasServiceToken ? "Client ID saved" : "Client ID"}
                  onChange={(event) => { setCfClientId(event.target.value); }}
                />
                <Input
                  aria-label="Cloudflare Access client secret"
                  type="password"
                  value={cfClientSecret}
                  placeholder={state.hasServiceToken ? "Client secret saved" : "Client secret"}
                  onChange={(event) => { setCfClientSecret(event.target.value); }}
                />
              </div>
              {state.hasServiceToken ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  disabled={busy}
                  onClick={() => { save({ token: null, cfClientId: "", cfClientSecret: "" }, "Service token removed."); }}
                >
                  Remove service token
                </Button>
              ) : null}
            </Disclosure>

            <Disclosure
              title="API key"
              summary={state.hasToken ? "API key saved, used instead of sign-in" : "Instead of signing in"}
            >
              <Input
                aria-label="Executor API key"
                type="password"
                value={token}
                placeholder={state.hasToken ? "Saved. Type to replace." : "Executor API key"}
                onChange={(event) => { setToken(event.target.value); }}
              />
              {state.hasToken ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  disabled={busy}
                  onClick={() => { save({ token: "", cfClientId: null, cfClientSecret: null }, "API key removed."); }}
                >
                  Remove API key
                </Button>
              ) : null}
            </Disclosure>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant={signedIn ? "outline" : "default"} disabled={busy || url.trim() === ""}>
                Save
              </Button>
              {state.url !== null && !state.hasToken ? (
                <Button
                  type="button"
                  size="sm"
                  variant={signedIn ? "outline" : "default"}
                  disabled={busy}
                  onClick={connect}
                >
                  {state.auth === "connected" ? "Sign in again" : "Sign in"}
                </Button>
              ) : null}
              {state.url !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => { void run(() => rpcRef.current.call("sync", null)); }}
                >
                  Refresh
                </Button>
              ) : null}
              {state.url !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    setUrl("");
                    void run(() => rpcRef.current.call("disconnect", null));
                  }}
                >
                  Disconnect
                </Button>
              ) : null}
            </div>
          </form>

          {message !== null ? (
            <p className={`text-xs ${message.error ? "text-destructive" : "text-muted-foreground"}`}>
              {message.text}
            </p>
          ) : null}
          {state.error !== null ? <p className="text-xs text-destructive">{state.error}</p> : null}

          {state.changedTools.length > 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-border p-2 text-xs">
              <span className="text-muted-foreground">
                {state.changedTools.join(", ")} changed. Agents see the new version after a reload, which
                cancels open prompts in every thread.
              </span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                disabled={busy}
                onClick={() => { void run(() => rpcRef.current.call("reload", null)); }}
              >
                Reload
              </Button>
            </div>
          ) : null}
        </section>

        {state.apps.length > 0 ? (
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-foreground">Apps</h2>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                disabled={busy}
                onClick={() => {
                  void run(async () => { setUpdates(await rpcRef.current.call("check_updates", null)); });
                }}
              >
                Check for updates
              </Button>
            </div>
            {updates !== null && updates.apps.some((update) => (update.catalogChanges ?? 0) > 0) ? (
              <p className="text-xs text-muted-foreground">
                An app that differs from the catalog was either changed in Executor or has a newer catalog
                version. Open it to compare and redeploy.
              </p>
            ) : null}
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {state.apps.map((app) => (
                <li key={app.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-foreground">{app.name}</span>
                    {updateText(updates?.apps.find((update) => update.id === app.id), updates?.framework ?? null) !== null ? (
                      <span className="truncate text-foreground">
                        {updateText(updates?.apps.find((update) => update.id === app.id), updates?.framework ?? null)}
                      </span>
                    ) : null}
                    <span className="truncate text-muted-foreground">
                      {[
                        ...app.accounts.map((account) =>
                          account.signIn === "saved" || account.signIn === "connected"
                            ? account.label
                            : `${account.label} (${account.signIn})`),
                        ...app.missing.map((requirement) => `${requirement}: no account`),
                      ].join(", ") || "No accounts needed"}
                    </span>
                  </div>
                  {state.dashboardUrl !== null ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => { navigate.openUrl(`${state.dashboardUrl}/apps/${app.id}`); }}
                    >
                      Open
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">Auto-approve</h2>
          {state.mode !== null ? (
            <p className={`text-xs ${state.mode === "model" ? "text-muted-foreground" : "text-foreground"}`}>
              {MODE_NOTES[state.mode] ?? `Executor is in "${state.mode}" mode.`}
              {state.mode === "model" ? null : " To change it, sign in again and pick model on Executor's consent page."}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Checkbox
              id="approve-all"
              checked={state.approveAll}
              disabled={busy}
              onCheckedChange={(checked) => {
                void run(() => rpcRef.current.call("set_approve_all", { enabled: checked === true }));
              }}
            />
            <Label htmlFor="approve-all">Approve every Executor action</Label>
          </div>

          {state.rules.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {state.rules.map((pattern) => (
                <li key={pattern} className="flex items-center gap-2 px-2 py-1">
                  <span className="truncate font-mono text-xs text-foreground">{pattern}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() => { void run(() => rpcRef.current.call("delete_rule", { pattern })); }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              No rules yet. Choose Always approve on a prompt, or add a tool name here.
            </p>
          )}

          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => rpcRef.current.call("add_rule", { pattern: rule }));
              setRule("");
            }}
          >
            <Input
              value={rule}
              placeholder="app.tool, or a prefix ending in *"
              aria-label="app.tool, or a prefix ending in *"
              onChange={(event) => { setRule(event.target.value); }}
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || rule.trim() === ""}>
              Add
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
