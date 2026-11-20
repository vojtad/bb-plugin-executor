import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  EXECUTOR_CHANGED,
  type ExecutorRpcContract,
  type ExecutorState,
  OAUTH_CALLBACK_SUBPATH,
  PLUGIN_ID,
} from "../../contract.js";

/** OAuth codes already sent, so StrictMode's double effect cannot spend one twice. */
const exchanged = new Set<string>();

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
  const [rule, setRule] = useState("");
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

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-medium text-foreground">Executor</h1>
            <span className="text-xs text-muted-foreground">{statusText(state)}</span>
          </div>

          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => rpcRef.current.call("configure", {
                url,
                token: token === "" ? null : token,
              }), "Saved.");
              setToken("");
            }}
          >
            <Label htmlFor="executor-url">URL</Label>
            <Input
              id="executor-url"
              value={url}
              placeholder="https://executor.example.com/mcp"
              onChange={(event) => { setUrl(event.target.value); }}
            />
            <Label htmlFor="executor-token">Access token (optional)</Label>
            <Input
              id="executor-token"
              type="password"
              value={token}
              placeholder={state.hasToken ? "Saved. Type to replace." : "Leave empty to sign in instead"}
              onChange={(event) => { setToken(event.target.value); }}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy || url.trim() === ""}>Save</Button>
              {state.url !== null && !state.hasToken && state.auth !== "connected" ? (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={connect}>
                  Sign in
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
                  Refresh tools
                </Button>
              ) : null}
              {state.hasToken ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => { void run(() => rpcRef.current.call("configure", { url, token: "" })); }}
                >
                  Remove token
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

          {state.tools.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Tools: {state.tools.join(", ")}
            </p>
          ) : null}

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

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">Auto-approve</h2>
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
