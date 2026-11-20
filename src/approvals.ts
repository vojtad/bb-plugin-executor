import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import {
  APPROVAL_RENDERER_ID,
  type ApprovalField,
  type ApprovalPayload,
  approvalResponseSchema,
} from "../contract.js";

/**
 * How long a prompt stays open. It runs inside the `execute` call, which BB's
 * tool round trip cuts off near five minutes (see CALL_TIMEOUT_MS), and v1
 * Executor gives up on a pending approval after four.
 */
export const APPROVAL_TIMEOUT_MS = 180_000;

const TITLE_MAX_CHARS = 160;
const MESSAGE_MAX_CHARS = 4_000;

/**
 * Executor's own policy gate asks "Approve <tool>?" with an empty form, in v1
 * and v2 alike. Anything else - a tool asking for input, a sign-in link, an
 * approval carrying its own terms in `_meta` - is not a policy approval and is
 * never auto-accepted.
 */
export function approvedTool(params: ElicitRequest["params"]): string | null {
  if (params.mode === "url") return null;
  if (params._meta !== undefined && Object.keys(params._meta).length > 0) return null;
  if (Object.keys(params.requestedSchema.properties).length > 0) return null;
  return /^Approve (\S+)\?/.exec(params.message)?.[1] ?? null;
}

/** An exact tool name, or a prefix ending in `*` (e.g. `google_gmail.*`). */
export function matchesRule(rules: readonly string[], tool: string): boolean {
  return rules.some((rule) =>
    rule.endsWith("*") ? tool.startsWith(rule.slice(0, -1)) : rule === tool);
}

function formFields(params: ElicitRequest["params"]): ApprovalField[] {
  if (params.mode === "url") return [];
  const { properties, required = [] } = params.requestedSchema;
  const fields: ApprovalField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const schema = property as { type?: string; title?: string; enum?: unknown[] };
    const type = schema.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") {
      continue;
    }
    fields.push({
      name,
      title: schema.title ?? name,
      type,
      options: Array.isArray(schema.enum) ? schema.enum.map(String) : null,
      required: required.includes(name),
    });
  }
  return fields;
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export interface Approvals {
  answer(
    params: ElicitRequest["params"],
    ctx: { threadId: string; signal: AbortSignal },
  ): Promise<ElicitResult>;
}

export function createApprovals(deps: {
  requestInput: BbPluginApi["ui"]["requestInput"];
  approveAll(): boolean;
  rules(): string[];
  addRule(pattern: string): void;
  timeoutMs?: number;
}): Approvals {
  // A thread holds one pending interaction at a time, and an agent may run
  // several `execute` calls in parallel, so prompts queue per thread.
  const queues = new Map<string, Promise<unknown>>();

  function enqueue<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const running = (queues.get(threadId) ?? Promise.resolve()).then(task, task);
    const settled = running.then(() => undefined, () => undefined);
    queues.set(threadId, settled);
    void settled.then(() => { if (queues.get(threadId) === settled) queues.delete(threadId); });
    return running;
  }

  const autoApproved = (tool: string | null): boolean =>
    tool !== null && (deps.approveAll() || matchesRule(deps.rules(), tool));

  async function prompt(
    params: ElicitRequest["params"],
    tool: string | null,
    ctx: { threadId: string; signal: AbortSignal },
  ): Promise<ElicitResult> {
    const payload: ApprovalPayload = {
      message: shorten(params.message, MESSAGE_MAX_CHARS),
      tool,
      fields: formFields(params),
    };
    let result;
    try {
      result = await deps.requestInput({
        threadId: ctx.threadId,
        rendererId: APPROVAL_RENDERER_ID,
        title: shorten(tool === null ? "Executor needs input" : `Approve ${tool}?`, TITLE_MAX_CHARS),
        payload,
        timeoutMs: deps.timeoutMs ?? APPROVAL_TIMEOUT_MS,
      }, { signal: ctx.signal });
    } catch {
      // Another prompt (a provider permission, AskUserQuestion) holds the slot.
      return { action: "cancel" };
    }
    if (result.outcome === "cancelled") return { action: "cancel" };
    const parsed = approvalResponseSchema.safeParse(result.value);
    if (!parsed.success || parsed.data.decision === "deny") return { action: "decline" };
    if (parsed.data.decision === "always" && tool !== null) deps.addRule(tool);
    return { action: "accept", content: parsed.data.content };
  }

  return {
    answer(params, ctx) {
      if (params.mode === "url") return Promise.resolve({ action: "decline" });
      const tool = approvedTool(params);
      if (autoApproved(tool)) return Promise.resolve({ action: "accept", content: {} });
      // Re-checked after the queue: an "Always" answered just ahead covers this one.
      return enqueue(ctx.threadId, () =>
        autoApproved(tool) ? Promise.resolve({ action: "accept", content: {} }) : prompt(params, tool, ctx));
    },
  };
}
