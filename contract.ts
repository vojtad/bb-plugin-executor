import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const EXECUTOR_CHANGED = "executor-changed";

export const PLUGIN_ID = "executor";
export const OAUTH_CALLBACK_SUBPATH = "oauth/callback";
const PANEL_ROUTE = `/plugins/${PLUGIN_ID}/executor`;

/**
 * The OAuth redirect lands on the panel rather than on the plugin's public
 * HTTP route, so it also works on an origin behind a BB sign-in. Shared by
 * panel and server: the authorization server compares it byte for byte.
 */
export function oauthRedirectUriFor(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${PANEL_ROUTE}/${OAUTH_CALLBACK_SUBPATH}`;
}

export const stateSchema = z.object({
  url: z.string().nullable(),
  hasToken: z.boolean(),
  auth: z.enum(["disconnected", "connected", "needs-reconnect"]),
  error: z.string().nullable(),
  syncedAt: z.number().nullable(),
  tools: z.array(z.string()),
  /** Tools whose description changed since registration: a reload is owed. */
  changedTools: z.array(z.string()),
  approveAll: z.boolean(),
  rules: z.array(z.string()),
});
export type ExecutorState = z.infer<typeof stateSchema>;

const ok = z.object({ ok: z.literal(true) });

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: stateSchema },
  /** Save the URL and an optional access token (null keeps the stored one, "" clears it). */
  configure: {
    input: z.object({ url: z.string(), token: z.string().nullable() }),
    output: ok,
  },
  connect: {
    input: z.object({ redirectOrigin: z.string() }),
    output: z.object({ authorizeUrl: z.string() }),
  },
  oauth_complete: {
    input: z.object({ state: z.string(), code: z.string() }),
    output: ok,
  },
  disconnect: { input: z.null(), output: ok },
  sync: { input: z.null(), output: ok },
  reload: { input: z.null(), output: ok },
  set_approve_all: { input: z.object({ enabled: z.boolean() }), output: ok },
  add_rule: { input: z.object({ pattern: z.string() }), output: ok },
  delete_rule: { input: z.object({ pattern: z.string() }), output: ok },
});
export type ExecutorRpcContract = typeof rpcContract;

export const APPROVAL_RENDERER_ID = "executor-approval";

export const approvalFieldSchema = z.object({
  name: z.string(),
  title: z.string(),
  type: z.enum(["string", "number", "integer", "boolean"]),
  options: z.array(z.string()).nullable(),
  required: z.boolean(),
});
export type ApprovalField = z.infer<typeof approvalFieldSchema>;

export const approvalPayloadSchema = z.object({
  message: z.string(),
  /** The Executor tool being approved; null for any other question a tool asks. */
  tool: z.string().nullable(),
  fields: z.array(approvalFieldSchema),
});
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;

export const approvalResponseSchema = z.object({
  decision: z.enum(["once", "always", "deny"]),
  content: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;
