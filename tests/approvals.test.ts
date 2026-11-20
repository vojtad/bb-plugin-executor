import type { PluginInteractionRequest } from "@get-bb/plugin-sdk";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApprovals } from "../src/approvals.js";
import { createExecutorClient } from "../src/executor.js";

/** A stand-in Executor v2 in model mode: `call` pauses, `resume` finishes it. */
function fakeExecutor(paused: Record<string, unknown>) {
  const answers: unknown[] = [];
  const server = new McpServer({ name: "executor", version: "0" });
  server.registerTool("call", { inputSchema: { calls: z.unknown() } }, async () =>
    ({ content: [{ type: "text", text: "paused" }], structuredContent: paused }));
  server.registerTool(
    "resume",
    { inputSchema: { requestId: z.string(), response: z.object({ action: z.string() }).passthrough() } },
    async ({ response }) => {
      answers.push(response);
      const status = response.action === "accept" ? "sent" : "not sent";
      return { content: [{ type: "text", text: status }], structuredContent: { status: "completed" } };
    },
  );
  const client = createExecutorClient({
    url: () => "https://executor.test/mcp",
    authHeaders: async () => ({}),
    refreshAuth: async () => false,
    createTransport: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void server.connect(serverSide);
      return clientSide;
    },
  });
  return { client, answers };
}

const APPROVAL = {
  status: "approval-required",
  requestId: "apr_1",
  invocation: { app: "gmail", tool: "send", input: { to: "a@b.c" } },
  elicitation: { mode: "form", message: "Approve send?\n\nArguments:\n{\"to\":\"a@b.c\"}", requestedSchema: { type: "object", properties: {} } },
  expiresAt: 0,
};

async function run(paused: Record<string, unknown>, options: { rules?: string[]; approveAll?: boolean; reply?: unknown }) {
  const executor = fakeExecutor(paused);
  const rules = [...(options.rules ?? [])];
  const requestInput = vi.fn(async (_request: PluginInteractionRequest) =>
    ({ outcome: "submitted" as const, value: options.reply ?? { decision: "deny", content: {} } }));
  const approvals = createApprovals({
    requestInput: requestInput as never,
    approveAll: () => options.approveAll ?? false,
    rules: () => rules,
    addRule: (pattern) => { rules.push(pattern); },
  });
  const ctx = { threadId: "thr_1", signal: new AbortController().signal };
  const result = await executor.client.callTool("call", { calls: [] }, {
    signal: ctx.signal,
    decide: (pending) => approvals.answer(pending, ctx),
  });
  return { result, answers: executor.answers, requestInput, rules };
}

describe("Executor approvals", () => {
  it("approves an app tool matching a prefix rule without asking", async () => {
    const { answers, requestInput, result } = await run(APPROVAL, { rules: ["gmail.*"] });
    expect(answers).toEqual([{ action: "accept", content: {} }]);
    expect(requestInput).not.toHaveBeenCalled();
    expect(result.content).toEqual([{ type: "text", text: "sent" }]);
  });

  it("asks the user otherwise, and Always approve becomes a rule for that app tool", async () => {
    const { answers, requestInput, rules } = await run(APPROVAL, {
      reply: { decision: "always", content: {} },
    });
    expect(answers).toEqual([{ action: "accept", content: {} }]);
    expect(requestInput).toHaveBeenCalledTimes(1);
    expect(rules).toEqual(["gmail.send"]);
  });

  it("passes a denial back to Executor", async () => {
    const { answers, result } = await run(APPROVAL, {});
    expect(answers).toEqual([{ action: "decline" }]);
    expect(result.content).toEqual([{ type: "text", text: "not sent" }]);
  });

  it("never auto-approves a question a tool asks, even with Approve all on", async () => {
    const { requestInput, answers } = await run(
      {
        status: "input-required",
        requestId: "elc_1",
        tool: { app: "calendar", tool: "create" },
        elicitation: { message: "Which calendar?", requestedSchema: { type: "object", properties: { calendar: { type: "string" } } } },
        expiresAt: 0,
      },
      { approveAll: true, reply: { decision: "once", content: { calendar: "work" } } },
    );
    expect(requestInput).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([{ action: "accept", content: { calendar: "work" } }]);
  });
});
