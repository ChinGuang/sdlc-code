import {
  ChatApiError,
  type ChatRequest,
  type ChatResponse,
  type ToolCall,
} from "@sdlc-code/clients";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ChatAgentLoop,
  type AgentLoop,
  type AgentLoopOptions,
  type TokenBudget,
  type TranscriptEvent,
} from "./agentLoop.js";
import { defineTool } from "./tools.js";

/** A scripted model: returns queued replies in order and records every request. */
function scriptedModel(replies: Array<Partial<ChatResponse> | Error>) {
  const requests: ChatRequest[] = [];
  return {
    requests,
    client: {
      complete: async (request: ChatRequest): Promise<ChatResponse> => {
        requests.push(structuredClone(request));
        const next = replies.shift();
        if (!next) throw new Error("model called more times than scripted");
        if (next instanceof Error) throw next;
        return {
          content: null,
          reasoning: null,
          toolCalls: [],
          finishReason: "stop",
          usage: { promptTokens: 100, completionTokens: 10 },
          latencyMs: 5,
          ...next,
        };
      },
    },
  };
}

const toolCall = (
  name: string,
  args: unknown,
  id = `call-${name}`,
): ToolCall => ({
  id,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});

const files: Record<string, string> = { "a.ts": "export const a = 1;" };
const readFile = defineTool({
  name: "read_file",
  description: "Read a file",
  input: z.object({ path: z.string() }),
  run: ({ path }) => {
    const content = files[path];
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  },
});

function budgetOf(limit: number): TokenBudget & { used: () => number } {
  let used = 0;
  return {
    remaining: () => limit - used,
    spend: (tokens) => {
      used += tokens;
    },
    used: () => used,
  };
}

// Tests depend on the interface; only this factory knows the class.
function makeLoop(
  replies: Array<Partial<ChatResponse> | Error>,
  options: Partial<AgentLoopOptions> = {},
) {
  const model = scriptedModel(replies);
  const events: TranscriptEvent[] = [];
  const sleeps: number[] = [];
  const loop: AgentLoop = new ChatAgentLoop({
    client: model.client,
    request: { model: "nvidia/nemotron-3-super-120b-a12b" },
    tools: [readFile],
    maxIterations: 5,
    transcript: { record: (event) => events.push(event) },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { loop, requests: model.requests, events, sleeps };
}

const task = {
  system: "You are the Backend Coding Agent.",
  user: "What is in a.ts?",
};
const memoryReply = { content: "Read a.ts; it exports a = 1. Nothing failed." };

describe("ChatAgentLoop: tool call → result → final answer", () => {
  it("runs the tool, returns its result to the model and ends with the answer", async () => {
    const { loop, requests } = makeLoop([
      {
        toolCalls: [toolCall("read_file", { path: "a.ts" })],
        finishReason: "tool_calls",
      },
      { content: "a.ts exports a = 1." },
      memoryReply,
    ]);

    const result = await loop.run(task);

    expect(result).toMatchObject({
      stopReason: "answered",
      answer: "a.ts exports a = 1.",
      workingMemory: "Read a.ts; it exports a = 1. Nothing failed.",
      iterations: 2,
      toolCalls: 1,
      failedToolCalls: 0,
      usage: { promptTokens: 300, completionTokens: 30 },
    });
    expect(requests[0]).toMatchObject({
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: [
        { role: "system", content: task.system },
        { role: "user", content: task.user },
      ],
      tools: [readFile.definition],
    });
    expect(requests[1]?.messages.slice(2)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-read_file",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-read_file",
        content: "export const a = 1;",
      },
    ]);
  });

  it("asks for Working Memory without tools and with thinking off", async () => {
    const { loop, requests } = makeLoop([{ content: "done" }, memoryReply], {
      request: {
        model: "m",
        extra: { chat_template_kwargs: { enable_thinking: true } },
      },
    });

    await loop.run(task);

    const memoryRequest = requests[1]!;
    expect(memoryRequest.tools).toBeUndefined();
    expect(memoryRequest.extra).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(memoryRequest.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringMatching(/Working Memory/),
    });
  });

  it("records the Transcript, including reasoning, usage and Working Memory", async () => {
    const { loop, events } = makeLoop([
      {
        reasoning: "I should read the file.",
        toolCalls: [toolCall("read_file", { path: "a.ts" })],
      },
      { content: "a = 1", reasoning: "Done." },
      memoryReply,
    ]);

    await loop.run(task);

    expect(events.map((event) => event.type)).toEqual([
      "message",
      "message",
      "assistant",
      "usage",
      "toolResult",
      "assistant",
      "usage",
      "usage",
      "workingMemory",
    ]);
    expect(events[2]).toEqual({
      type: "assistant",
      content: null,
      reasoning: "I should read the file.",
      toolCalls: [toolCall("read_file", { path: "a.ts" })],
    });
    expect(events[4]).toEqual({
      type: "toolResult",
      toolCallId: "call-read_file",
      name: "read_file",
      content: "export const a = 1;",
      problem: null,
    });
  });
});

describe("ChatAgentLoop: images for a model with vision", () => {
  it("sends images as data URLs after the text, and keeps them out of the Transcript", async () => {
    const { loop, requests, events } = makeLoop([
      { content: "The list screen has a header." },
      { content: "- nothing to add" },
    ]);

    await loop.run({
      ...task,
      images: [{ bytes: Buffer.from("png-bytes"), mimeType: "image/png" }],
    });

    expect(requests[0]!.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: task.user },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
          },
        },
      ],
    });
    expect(events[1]).toEqual({
      type: "message",
      role: "user",
      content: `${task.user}\n\n[1 image attached]`,
    });
  });

  it("sends plain text when there are no images", async () => {
    const { loop, requests } = makeLoop([
      { content: "done" },
      { content: "- nothing" },
    ]);

    await loop.run(task);

    expect(requests[0]!.messages[1]).toEqual({
      role: "user",
      content: task.user,
    });
  });
});

describe("ChatAgentLoop: malformed and failing tool calls", () => {
  it("does not run tool calls from a reply cut off at the output limit", async () => {
    let ran = false;
    const write = defineTool({
      name: "write_ids",
      description: "Records ids",
      input: z.object({ ids: z.array(z.number()) }),
      run: () => {
        ran = true;
        return "ok";
      },
    });
    const { loop, requests } = makeLoop(
      [
        {
          // Cut from [12,345,…]; JSON repair alone would turn it into [12,34].
          toolCalls: [toolCall("write_ids", '{"ids":[12,34')],
          finishReason: "length",
        },
        { content: "done" },
        memoryReply,
      ],
      { tools: [write] },
    );

    const result = await loop.run(task);

    expect(ran).toBe(false);
    expect(result.failedToolCalls).toBe(1);
    expect(requests[1]?.messages.at(-1)?.content).toMatch(
      /write_ids was not run: your reply hit the output token limit/,
    );
  });

  it("returns malformed arguments, unknown tools and tool errors to the model and continues", async () => {
    const { loop, requests } = makeLoop([
      {
        toolCalls: [
          toolCall("read_file", '{"path":', "bad-json"),
          toolCall("delete_repo", {}, "unknown"),
          toolCall("read_file", { path: "missing.ts" }, "throws"),
        ],
      },
      { content: "I could not read the file." },
      memoryReply,
    ]);

    const result = await loop.run(task);

    expect(result).toMatchObject({
      stopReason: "answered",
      toolCalls: 3,
      failedToolCalls: 3,
    });
    const toolMessages = requests[1]!.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.content)).toEqual([
      expect.stringMatching(/^Error: invalid arguments for read_file/),
      expect.stringMatching(/^Error: unknown tool "delete_repo"/),
      "Error: read_file failed: no such file: missing.ts",
    ]);
  });

  it("truncates long tool results to keep the context short", async () => {
    files["big.ts"] = "x".repeat(50);
    const { loop, requests } = makeLoop(
      [
        { toolCalls: [toolCall("read_file", { path: "big.ts" })] },
        { content: "ok" },
        memoryReply,
      ],
      { maxToolResultChars: 20 },
    );

    await loop.run(task);

    const tool = requests[1]!.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe(`${"x".repeat(20)}\n…(truncated 30 characters)`);
  });
});

describe("ChatAgentLoop: limits", () => {
  it("stops at the Token Budget without running the turn's tool calls", async () => {
    const budget = budgetOf(100);
    const { loop, requests, events } = makeLoop(
      [{ toolCalls: [toolCall("read_file", { path: "a.ts" })] }],
      { budget },
    );

    const result = await loop.run(task);

    expect(result).toMatchObject({ stopReason: "tokenBudget", toolCalls: 0 });
    expect(requests).toHaveLength(1);
    expect(budget.used()).toBe(110);
    expect(events.some((event) => event.type === "toolResult")).toBe(false);
    // No tokens left for the model to write it, so the note is built in code.
    expect(result.workingMemory).toMatch(
      /Stopped: Token Budget exhausted after 1 model turn and 0 tool calls/,
    );
  });

  it("writes the note in code when one more prompt would not fit the budget", async () => {
    // 110 spent of 600: 490 left, less than the last prompt (100) + 500 for the note.
    const { loop, requests } = makeLoop([{ content: "done" }], {
      budget: budgetOf(600),
    });

    const result = await loop.run(task);

    expect(requests).toHaveLength(1);
    expect(result.workingMemory).toMatch(
      /^Stopped: answered after 1 model turn/,
    );
  });

  it("does not call the model at all when the budget is already spent", async () => {
    const { loop, requests } = makeLoop([], { budget: budgetOf(0) });

    const result = await loop.run(task);

    expect(result).toMatchObject({ stopReason: "tokenBudget", iterations: 0 });
    expect(requests).toHaveLength(0);
  });

  it("stops after maxIterations model turns", async () => {
    const again = { toolCalls: [toolCall("read_file", { path: "a.ts" })] };
    const { loop } = makeLoop([again, again, memoryReply], {
      maxIterations: 2,
    });

    const result = await loop.run(task);

    expect(result).toMatchObject({
      stopReason: "maxIterations",
      iterations: 2,
    });
    expect(result.workingMemory).toBe(memoryReply.content);
  });

  it("treats an empty final answer as a failed Step (spike rule 6)", async () => {
    const { loop } = makeLoop([{ content: "   " }, memoryReply]);

    const result = await loop.run(task);

    expect(result).toMatchObject({ stopReason: "emptyAnswer", answer: null });
  });

  it("falls back to a written-out note when the model's note is empty", async () => {
    const { loop } = makeLoop([{ content: "done" }, { content: "" }]);

    const result = await loop.run(task);

    expect(result.workingMemory).toMatch(
      /^Stopped: answered after 1 model turn/,
    );
  });
});

describe("ChatAgentLoop: API errors", () => {
  it("retries a 429 after Retry-After, then continues", async () => {
    const { loop, sleeps, events } = makeLoop([
      new ChatApiError(429, 7, "Token Factory 429: rate limited"),
      { content: "done" },
      memoryReply,
    ]);

    const result = await loop.run(task);

    expect(result.stopReason).toBe("answered");
    expect(sleeps).toEqual([7000]);
    expect(events).toContainEqual({
      type: "retry",
      status: 429,
      waitSeconds: 7,
    });
  });

  it("backs off exponentially on 5xx without Retry-After", async () => {
    const { loop, sleeps } = makeLoop([
      new ChatApiError(503, null, "unavailable"),
      new ChatApiError(502, null, "bad gateway"),
      { content: "done" },
      memoryReply,
    ]);

    await loop.run(task);

    expect(sleeps).toEqual([1000, 2000]);
  });

  it("gives up after maxApiAttempts and still ends the Step with a note", async () => {
    const error = new ChatApiError(503, null, "Token Factory 503: unavailable");
    const { loop, requests, events } = makeLoop([error, error], {
      maxApiAttempts: 2,
    });

    const result = await loop.run(task);

    expect(result).toMatchObject({
      stopReason: "apiError",
      answer: null,
      error: "Token Factory 503: unavailable",
    });
    expect(requests).toHaveLength(2);
    expect(result.workingMemory).toMatch(
      /^Stopped: Token Factory error after 0 model turns.*Error: Token Factory 503: unavailable$/,
    );
    expect(events).toContainEqual({
      type: "apiError",
      status: 503,
      message: "Token Factory 503: unavailable",
    });
  });

  it("does not retry client errors", async () => {
    const error = new ChatApiError(400, null, "bad request");
    const { loop, sleeps } = makeLoop([error]);

    await expect(loop.run(task)).resolves.toMatchObject({
      stopReason: "apiError",
      error: "bad request",
    });
    expect(sleeps).toEqual([]);
  });

  it("rethrows errors that are not Token Factory errors (bugs)", async () => {
    const bug = new TypeError("x is not a function");
    const { loop } = makeLoop([bug]);

    await expect(loop.run(task)).rejects.toBe(bug);
  });

  it("uses the written-out note when the note request itself fails", async () => {
    const { loop } = makeLoop([
      { content: "done" },
      new ChatApiError(400, null, "too long"),
    ]);

    const result = await loop.run(task);

    expect(result.stopReason).toBe("answered");
    expect(result.workingMemory).toMatch(
      /^Stopped: answered after 1 model turn/,
    );
  });

  it("run works when passed as a callback", async () => {
    const { loop } = makeLoop([{ content: "done" }, memoryReply]);
    const { run } = loop;

    await expect(run(task)).resolves.toMatchObject({ stopReason: "answered" });
  });
});
