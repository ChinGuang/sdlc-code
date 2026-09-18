import { describe, expect, it, vi } from "vitest";
import type { ChatClient, ChatRequest, ChatResponse } from "./chatClient.js";
import { ChatToolLoop, type LoopTools, type ToolLoop } from "./toolLoop.js";

const reply = (partial: Partial<ChatResponse>): ChatResponse => ({
  content: null,
  reasoning: null,
  toolCalls: [],
  finishReason: "stop",
  usage: { promptTokens: 10, completionTokens: 5 },
  latencyMs: 100,
  ...partial,
});

function scriptedClient(replies: ChatResponse[]) {
  const requests: ChatRequest[] = [];
  const client: ChatClient = {
    complete: vi.fn(async (request: ChatRequest) => {
      requests.push(structuredClone(request));
      const next = replies.shift();
      if (!next) throw new Error("no more scripted replies");
      return next;
    }),
  };
  return { client, requests };
}

const readFile = vi.fn(
  (args: Record<string, unknown>) => `content of ${String(args.path)}`,
);
const tools: LoopTools = {
  read_file: {
    definition: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    handler: readFile,
  },
};

// Tests depend on the interface; only this factory knows the class.
const makeLoop = (
  client: ChatClient,
  maxIterations = 10,
  loopTools: LoopTools = tools,
): ToolLoop =>
  new ChatToolLoop({
    client,
    model: "nvidia/m",
    tools: loopTools,
    maxIterations,
  });

describe("ChatToolLoop.run", () => {
  it("executes tool calls, feeds results back, and returns the final answer", async () => {
    const { client, requests } = scriptedClient([
      reply({
        toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }],
        finishReason: "tool_calls",
      }),
      reply({ content: "done: a" }),
    ]);

    const result = await makeLoop(client).run({ system: "sys", user: "go" });

    expect(result).toMatchObject({
      stopReason: "answered",
      finalContent: "done: a",
      iterations: 2,
      toolCallCount: 1,
      malformedArguments: 0,
      unknownTools: 0,
      usage: { promptTokens: 20, completionTokens: 10 },
      latencyMs: 200,
    });
    expect(requests[1]!.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "content of a" },
    ]);
  });

  it("counts parallel tool calls in one turn", async () => {
    const { client } = scriptedClient([
      reply({
        toolCalls: [
          { id: "c1", name: "read_file", arguments: '{"path":"a"}' },
          { id: "c2", name: "read_file", arguments: '{"path":"b"}' },
        ],
      }),
      reply({ content: "ok" }),
    ]);

    const result = await makeLoop(client).run({ system: "s", user: "u" });

    expect(result).toMatchObject({ toolCallCount: 2, parallelTurns: 1 });
  });

  it("reports malformed arguments and unknown tools back to the model", async () => {
    const { client, requests } = scriptedClient([
      reply({
        toolCalls: [
          { id: "c1", name: "read_file", arguments: '{"path":' },
          { id: "c2", name: "delete_repo", arguments: "{}" },
        ],
      }),
      reply({ content: "sorry" }),
    ]);

    const result = await makeLoop(client).run({ system: "s", user: "u" });

    expect(result).toMatchObject({ malformedArguments: 1, unknownTools: 1 });
    const toolMessages = requests[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.content)).toEqual([
      expect.stringMatching(/^Error: invalid arguments/),
      expect.stringMatching(/^Error: unknown tool delete_repo/),
    ]);
  });

  it("turns a throwing handler into an error result instead of crashing", async () => {
    const failing: LoopTools = {
      read_file: {
        ...tools.read_file!,
        handler: () => {
          throw new Error("disk on fire");
        },
      },
    };
    const { client, requests } = scriptedClient([
      reply({ toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] }),
      reply({ content: "ok" }),
    ]);
    await makeLoop(client, 5, failing).run({ system: "s", user: "u" });

    expect(requests[1]!.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "Error: disk on fire",
    });
  });

  it("stops at maxIterations", async () => {
    const endless = Array.from({ length: 5 }, (_, i) =>
      reply({
        toolCalls: [{ id: `c${i}`, name: "read_file", arguments: "{}" }],
      }),
    );
    const { client } = scriptedClient(endless);

    const result = await makeLoop(client, 3).run({ system: "s", user: "u" });

    expect(result).toMatchObject({
      stopReason: "max_iterations",
      iterations: 3,
    });
  });

  it("run works when passed as a callback", async () => {
    const { client } = scriptedClient([reply({ content: "hi" })]);
    const { run } = makeLoop(client);

    await expect(run({ system: "s", user: "u" })).resolves.toMatchObject({
      finalContent: "hi",
    });
  });
});
