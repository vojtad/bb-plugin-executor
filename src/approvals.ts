import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  APPROVAL_RENDERER_ID,
  type ApprovalField,
  type ApprovalPayload,
  approvalResponseSchema,
} from "../contract.js";

/**
 * How long a prompt stays open. It runs inside the tool call, which BB's tool
 * round trip cuts off near five minutes (see CALL_TIMEOUT_MS).
 */
export const APPROVAL_TIMEOUT_MS = 180_000;

const TITLE_MAX_CHARS = 160;
const MESSAGE_MAX_CHARS = 4_000;

/** A paused `execute` or `call`, as Executor returns it in model mode. */
export interface Pending {
  requestId: string;
  /** `app.tool` of a policy approval; null for a question a running tool asks. */
  tool: string | null;
  /** `app.tool` the question comes from, for the prompt title. */
  source: string;
  message: string;
  requestedSchema: { properties?: Record<string, unknown>; required?: string[] };
}

export interface Response {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean>;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function pendingInteraction(structured: unknown): Pending | null {
  if (!isRecord(structured) || typeof structured.requestId !== "string") return null;
  const elicitation = isRecord(structured.elicitation) ? structured.elicitation : {};
  const base = {
    requestId: structured.requestId,
    message: typeof elicitation.message === "string" ? elicitation.message : "",
    requestedSchema: isRecord(elicitation.requestedSchema) ? elicitation.requestedSchema : {},
  };
  const name = (from: unknown): string =>
    isRecord(from) ? `${String(from.app)}.${String(from.tool)}` : "unknown";
  if (structured.status === "approval-required") {
    const tool = name(structured.invocation);
    return { ...base, tool, source: tool };
  }
  if (structured.status === "input-required") {
    return { ...base, tool: null, source: name(structured.tool) };
  }
  return null;
}

/** An exact `app.tool`, or a prefix ending in `*` (e.g. `gmail.*`). */
export function matchesRule(rules: readonly string[], tool: string): boolean {
  return rules.some((rule) =>
    rule.endsWith("*") ? tool.startsWith(rule.slice(0, -1)) : rule === tool);
}

function formFields(schema: Pending["requestedSchema"]): ApprovalField[] {
  const required = schema.required ?? [];
  const fields: ApprovalField[] = [];
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const { type, title, enum: options } = property as { type?: string; title?: string; enum?: unknown[] };
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") continue;
    fields.push({
      name,
      title: title ?? name,
      type,
      options: Array.isArray(options) ? options.map(String) : null,
      required: required.includes(name),
    });
  }
  return fields;
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export interface Approvals {
  answer(pending: Pending, ctx: { threadId: string; signal: AbortSignal }): Promise<Response>;
}

export function createApprovals(deps: {
  requestInput: BbPluginApi["ui"]["requestInput"];
  approveAll(): boolean;
  rules(): string[];
  addRule(pattern: string): void;
  timeoutMs?: number;
}): Approvals {
  // A thread holds one pending interaction at a time, and an agent may run
  // several Executor calls in parallel, so prompts queue per thread.
  const queues = new Map<string, Promise<unknown>>();

  function enqueue<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const running = (queues.get(threadId) ?? Promise.resolve()).then(task, task);
    const settled = running.then(() => undefined, () => undefined);
    queues.set(threadId, settled);
    void settled.then(() => { if (queues.get(threadId) === settled) queues.delete(threadId); });
    return running;
  }

  const ACCEPT: Response = { action: "accept", content: {} };
  const autoApproved = (tool: string | null): boolean =>
    tool !== null && (deps.approveAll() || matchesRule(deps.rules(), tool));

  async function prompt(
    pending: Pending,
    ctx: { threadId: string; signal: AbortSignal },
  ): Promise<Response> {
    const payload: ApprovalPayload = {
      message: shorten(pending.message, MESSAGE_MAX_CHARS),
      tool: pending.tool,
      fields: formFields(pending.requestedSchema),
    };
    let result;
    try {
      result = await deps.requestInput({
        threadId: ctx.threadId,
        rendererId: APPROVAL_RENDERER_ID,
        title: shorten(
          pending.tool === null ? `${pending.source} needs input` : `Approve ${pending.tool}?`,
          TITLE_MAX_CHARS,
        ),
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
    if (parsed.data.decision === "always" && pending.tool !== null) deps.addRule(pending.tool);
    return { action: "accept", content: parsed.data.content };
  }

  return {
    answer(pending, ctx) {
      if (autoApproved(pending.tool)) return Promise.resolve(ACCEPT);
      // Re-checked after the queue: an "Always" answered just ahead covers this one.
      return enqueue(ctx.threadId, () =>
        autoApproved(pending.tool) ? Promise.resolve(ACCEPT) : prompt(pending, ctx));
    },
  };
}
