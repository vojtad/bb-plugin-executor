import type { PluginInteractionRequest } from "@get-bb/plugin-sdk";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApprovals } from "../src/approvals.js";
import { createExecutorClient } from "../src/executor.js";

/** A stand-in Executor whose `execute` asks for approval the way v1 and v2 do. */
function fakeExecutor(message: string, requestedSchema: { type: "object"; properties: Record<string, never> | Record<string, { type: "string" }> }) {
  const answers: string[] = [];
  const server = new McpServer({ name: "executor", version: "0" });
  server.registerTool("execute", { inputSchema: { code: z.string() } }, async (_args, extra) => {
    const answer = await server.server.elicitInput(
      { message, requestedSchema },
      { relatedRequestId: extra.requestId },
    );
    answers.push(answer.action);
    return { content: [{ type: "text", text: answer.action === "accept" ? "sent" : "not sent" }] };
  });
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

const APPROVAL = "Approve tools.google_gmail.user.me.send?\n\nArguments:\n{\"to\":\"a@b.c\"}";
const EMPTY = { type: "object" as const, properties: {} };

function setup(options: { rules?: string[]; approveAll?: boolean; reply?: unknown }) {
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
  return { approvals, requestInput, rules, ctx };
}

async function run(message: string, schema: Parameters<typeof fakeExecutor>[1], options: Parameters<typeof setup>[0]) {
  const executor = fakeExecutor(message, schema);
  const { approvals, requestInput, rules, ctx } = setup(options);
  const result = await executor.client.callTool("execute", { code: "" }, {
    signal: ctx.signal,
    elicit: (params) => approvals.answer(params, ctx),
  });
  return { result, answers: executor.answers, requestInput, rules };
}

describe("Executor approvals", () => {
  it("approves a tool matching a prefix rule without asking", async () => {
    const { answers, requestInput } = await run(APPROVAL, EMPTY, { rules: ["tools.google_gmail.*"] });
    expect(answers).toEqual(["accept"]);
    expect(requestInput).not.toHaveBeenCalled();
  });

  it("asks the user otherwise, and Always approve becomes a rule for that exact tool", async () => {
    const { answers, requestInput, rules } = await run(APPROVAL, EMPTY, {
      reply: { decision: "always", content: {} },
    });
    expect(answers).toEqual(["accept"]);
    expect(requestInput).toHaveBeenCalledTimes(1);
    expect(rules).toEqual(["tools.google_gmail.user.me.send"]);
  });

  it("passes a denial back to Executor", async () => {
    const { answers, result } = await run(APPROVAL, EMPTY, {});
    expect(answers).toEqual(["decline"]);
    expect(result.content).toEqual([{ type: "text", text: "not sent" }]);
  });

  it("never auto-approves a question a tool asks, even with Approve all on", async () => {
    const { requestInput, answers } = await run(
      "Which calendar?",
      { type: "object", properties: { calendar: { type: "string" } } },
      { approveAll: true, reply: { decision: "once", content: { calendar: "work" } } },
    );
    expect(requestInput).toHaveBeenCalledTimes(1);
    expect(answers).toEqual(["accept"]);
  });
});
