import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ChatApiError,
  TokenFactoryChatClient,
  type ChatClient,
  type ChatClientOptions,
  type ChatStreamEvent,
} from "./chatClient.js";

/** Recorded from Token Factory (nemotron-3-super, 2026-09-19), trimmed. */
const TOOL_CALL_STREAM = readFileSync(
  new URL("./fixtures/streamToolCall.sse", import.meta.url),
  "utf8",
);

/** A fetch that answers with an SSE body delivered in the given pieces. */
function sseFetch(pieces: string[], status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      },
    });
    return new Response(body, {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

// Tests depend on the interface; only this factory knows the class.
const makeClient = (options: ChatClientOptions): ChatClient =>
  new TokenFactoryChatClient(options);

const base = { apiKey: "key-123", baseUrl: "https://tf.test/v1" };

async function collect(
  events: AsyncIterable<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> {
  const all: ChatStreamEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe("TokenFactoryChatClient.stream", () => {
  it("asks for a stream with usage included", async () => {
    const { fetch, calls } = sseFetch([TOOL_CALL_STREAM]);
    await collect(
      makeClient({ ...base, fetch }).stream({ model: "m", messages: [] }),
    );

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("emits reasoning once per chunk and assembles the final response (recorded stream)", async () => {
    const { fetch } = sseFetch([TOOL_CALL_STREAM]);
    let now = 1000;
    const client = makeClient({ ...base, fetch, now: () => (now += 400) });

    const events = await collect(client.stream({ model: "m", messages: [] }));

    // Token Factory repeats each piece in `reasoning` and `reasoning_content`.
    expect(events.filter((e) => e.type === "reasoning")).toEqual([
      { type: "reasoning", text: "We" },
      { type: "reasoning", text: " need to get" },
      { type: "reasoning", text: " weather." },
    ]);
    expect(events.at(-1)).toEqual({
      type: "done",
      response: {
        content: null,
        reasoning: "We need to get weather.",
        toolCalls: [
          {
            id: "chatcmpl-tool-b4273976e29e1cdd",
            name: "get_weather",
            arguments: '{"city": "Paris", "unit": "celsius"}',
          },
        ],
        finishReason: "tool_calls",
        usage: { promptTokens: 379, completionTokens: 53 },
        latencyMs: 400,
      },
    });
  });

  it("streams content deltas and concatenates them", async () => {
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const { fetch } = sseFetch([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "It's " }),
      chunk({ content: "18°C." }, "stop"),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    const events = await collect(
      makeClient({ ...base, fetch }).stream({ model: "m", messages: [] }),
    );

    expect(events.filter((e) => e.type === "content")).toEqual([
      { type: "content", text: "It's " },
      { type: "content", text: "18°C." },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: { content: "It's 18°C.", finishReason: "stop" },
    });
  });

  it("handles events split across network chunks at any byte", async () => {
    const pieces: string[] = [];
    for (let i = 0; i < TOOL_CALL_STREAM.length; i += 7)
      pieces.push(TOOL_CALL_STREAM.slice(i, i + 7));
    const { fetch } = sseFetch(pieces);

    const events = await collect(
      makeClient({ ...base, fetch }).stream({ model: "m", messages: [] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: {
        toolCalls: [{ arguments: '{"city": "Paris", "unit": "celsius"}' }],
      },
    });
  });

  it("accepts CRLF line endings (allowed by the SSE spec)", async () => {
    const { fetch } = sseFetch([TOOL_CALL_STREAM.replaceAll("\n", "\r\n")]);

    const events = await collect(
      makeClient({ ...base, fetch }).stream({ model: "m", messages: [] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: { finishReason: "tool_calls" },
    });
  });

  it("throws ChatApiError when the request is rejected", async () => {
    const { fetch } = sseFetch(['{"error":{"message":"bad model"}}'], 400);

    await expect(
      collect(
        makeClient({ ...base, fetch }).stream({ model: "x", messages: [] }),
      ),
    ).rejects.toBeInstanceOf(ChatApiError);
  });

  it("works when passed as a callback", async () => {
    const { fetch } = sseFetch([TOOL_CALL_STREAM]);
    const { stream } = makeClient({ ...base, fetch });

    const events = await collect(stream({ model: "m", messages: [] }));
    expect(events.at(-1)?.type).toBe("done");
  });

  it("emits a tool_call event when each tool call starts", async () => {
    const { fetch } = sseFetch([TOOL_CALL_STREAM]);

    const events = await collect(
      makeClient({ ...base, fetch }).stream({ model: "m", messages: [] }),
    );

    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      {
        type: "tool_call",
        id: "chatcmpl-tool-b4273976e29e1cdd",
        name: "get_weather",
      },
    ]);
  });
});

describe("stream edge cases", () => {
  const data = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;
  const usage = { prompt_tokens: 5, completion_tokens: 2 };
  const delta = (d: object, finish: string | null = null) => ({
    choices: [{ index: 0, delta: d, finish_reason: finish }],
  });

  async function run(pieces: string[]) {
    const { fetch } = sseFetch(pieces);
    return collect(
      makeClient({ ...base, fetch }).stream({ model: "m", messages: [] }),
    );
  }

  it("assembles several tool calls by index", async () => {
    const events = await run([
      data(
        delta({
          tool_calls: [
            {
              index: 0,
              id: "a",
              function: { name: "read_file", arguments: '{"path":' },
            },
          ],
        }),
      ),
      data(
        delta({
          tool_calls: [
            {
              index: 1,
              id: "b",
              function: { name: "read_file", arguments: '{"path":"y"}' },
            },
          ],
        }),
      ),
      data(
        delta(
          { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
          "tool_calls",
        ),
      ),
      data({ choices: [], usage }),
      "data: [DONE]\n\n",
    ]);

    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: {
        toolCalls: [
          { id: "a", name: "read_file", arguments: '{"path":"x"}' },
          { id: "b", name: "read_file", arguments: '{"path":"y"}' },
        ],
      },
    });
  });

  it("decodes a multi-byte character split across network chunks", async () => {
    const bytes = new TextEncoder().encode(
      data(delta({ content: "18°C ✓" }, "stop")) +
        data({ choices: [], usage }) +
        "data: [DONE]\n\n",
    );
    const cut = bytes.indexOf(0xc2) + 1; // between the two bytes of "°"
    const fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.slice(0, cut));
            controller.enqueue(bytes.slice(cut));
            controller.close();
          },
        }),
      )) as unknown as typeof globalThis.fetch;

    const events = await collect(
      makeClient({ ...base, fetch }).stream({ model: "m", messages: [] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: { content: "18°C ✓" },
    });
  });

  it("ignores keep-alive comments and joins multi-line data fields", async () => {
    const payload = JSON.stringify(delta({ content: "hi" }, "stop"), null, 2);
    const multiLine = payload
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\n");

    const events = await run([
      ": keep-alive\n\n",
      `${multiLine}\n\n`,
      data({ choices: [], usage }),
      "data: [DONE]\n\n",
    ]);

    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: { content: "hi" },
    });
  });

  it("processes a final event that has no trailing blank line", async () => {
    const events = await run([
      data(delta({ content: "hi" }, "stop")),
      data({ choices: [], usage }),
      "data: [DONE]",
    ]);

    expect(events.at(-1)?.type).toBe("done");
  });

  it("throws ChatStreamError when the stream ends before [DONE]", async () => {
    await expect(
      run([data(delta({ content: "partial" }))]),
    ).rejects.toMatchObject({
      name: "ChatStreamError",
      message: expect.stringMatching(/ended before \[DONE\]/),
    });
  });

  it("throws ChatStreamError when the stream reports no token usage", async () => {
    await expect(
      run([data(delta({ content: "hi" }, "stop")), "data: [DONE]\n\n"]),
    ).rejects.toMatchObject({
      name: "ChatStreamError",
      message: expect.stringMatching(/usage/),
    });
  });

  it("throws ChatStreamError for an error sent inside the stream", async () => {
    await expect(
      run([
        data({ error: { message: "model overloaded" } }),
        "data: [DONE]\n\n",
      ]),
    ).rejects.toMatchObject({
      name: "ChatStreamError",
      message: expect.stringMatching(/model overloaded/),
    });
  });

  it("throws ChatStreamError for a malformed data payload", async () => {
    await expect(run(["data: {not json\n\n"])).rejects.toMatchObject({
      name: "ChatStreamError",
    });
  });
});
