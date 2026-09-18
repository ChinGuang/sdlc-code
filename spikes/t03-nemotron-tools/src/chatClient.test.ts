import { describe, expect, it, vi } from "vitest";
import {
  ChatApiError,
  costUsd,
  parseToolArguments,
  TokenFactoryChatClient,
  type ChatClient,
  type ChatClientOptions,
} from "./chatClient.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(
  responses: Array<{
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }>,
) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${String(url)}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

// Tests depend on the interface; only this factory knows the class.
const makeClient = (options: ChatClientOptions): ChatClient =>
  new TokenFactoryChatClient(options);

const base = { apiKey: "key-123", baseUrl: "https://tf.test/v1" };

const completion = (message: Record<string, unknown>, finish = "stop") => ({
  id: "c1",
  choices: [{ index: 0, message, finish_reason: finish }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
});

describe("TokenFactoryChatClient.complete", () => {
  it("posts an OpenAI-style request with tools, tool_choice and bearer auth", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: completion({ role: "assistant", content: "hi" }) },
    ]);
    await makeClient({ ...base, fetch }).complete({
      model: "nvidia/m",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      ],
      toolChoice: { name: "read_file" },
      temperature: 0,
      maxTokens: 50,
    });

    expect(calls[0]!.url).toBe("https://tf.test/v1/chat/completions");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
      "Bearer key-123",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "nvidia/m",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "read_file" } },
      temperature: 0,
      max_tokens: 50,
    });
  });

  it("maps a JSON schema into response_format", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: completion({ role: "assistant", content: "{}" }) },
    ]);
    const schema = { type: "object", properties: { a: { type: "string" } } };
    await makeClient({ ...base, fetch }).complete({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      jsonSchema: { name: "thing", schema },
    });

    expect(JSON.parse(String(calls[0]!.init.body)).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "thing", schema },
    });
  });

  it("returns content, tool calls, reasoning, usage and latency", async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        body: completion(
          {
            role: "assistant",
            content: null,
            reasoning_content: "thinking…",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a"}' },
              },
            ],
          },
          "tool_calls",
        ),
      },
    ]);
    let now = 1000;
    const client = makeClient({ ...base, fetch, now: () => (now += 250) });

    const response = await client.complete({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });

    expect(response).toEqual({
      content: null,
      reasoning: "thinking…",
      toolCalls: [
        { id: "call_1", name: "read_file", arguments: '{"path":"a"}' },
      ],
      finishReason: "tool_calls",
      usage: { promptTokens: 100, completionTokens: 20 },
      latencyMs: 250,
    });
  });

  it("surfaces API errors with status, message and Retry-After", async () => {
    const { fetch } = fakeFetch([
      {
        status: 429,
        body: { error: { message: "rate limited" } },
        headers: { "retry-after": "7" },
      },
    ]);

    await expect(
      makeClient({ ...base, fetch }).complete({ model: "m", messages: [] }),
    ).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 7,
      message: expect.stringMatching(/429.*rate limited/),
    });
  });

  it("public methods work when passed as callbacks", async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: completion({ role: "assistant", content: "ok" }) },
    ]);
    const { complete } = makeClient({ ...base, fetch });

    await expect(complete({ model: "m", messages: [] })).resolves.toMatchObject(
      {
        content: "ok",
      },
    );
  });

  it("never exposes the API key", () => {
    const client = makeClient({ ...base, apiKey: "secret-xyz" });

    expect(Object.keys(client)).toEqual(["complete"]);
    expect("apiKey" in client).toBe(false);
    expect(JSON.stringify(client)).not.toContain("secret-xyz");
  });
});

describe("ChatApiError", () => {
  it("never includes the API key", async () => {
    const { fetch } = fakeFetch([
      { status: 401, body: { error: { message: "invalid token" } } },
    ]);
    const error = await makeClient({ ...base, apiKey: "secret-xyz", fetch })
      .complete({ model: "m", messages: [] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChatApiError);
    expect(JSON.stringify(error)).not.toContain("secret-xyz");
    expect(String(error)).not.toContain("secret-xyz");
    expect(Object.keys(error as object).sort()).toEqual([
      "name",
      "retryAfterSeconds",
      "status",
    ]);
  });
});

describe("parseToolArguments", () => {
  it("parses a JSON object", () => {
    expect(parseToolArguments('{"path":"a.txt"}')).toEqual({
      ok: true,
      value: { path: "a.txt" },
    });
  });

  it("treats an empty string as no arguments", () => {
    expect(parseToolArguments("")).toEqual({ ok: true, value: {} });
  });

  it("rejects invalid JSON and non-objects", () => {
    expect(parseToolArguments('{"path":')).toMatchObject({ ok: false });
    expect(parseToolArguments("[1,2]")).toMatchObject({ ok: false });
  });
});

describe("costUsd", () => {
  it("prices prompt and completion tokens per million", () => {
    expect(
      costUsd(
        { promptTokens: 1_000_000, completionTokens: 500_000 },
        { promptPerMillion: 0.3, completionPerMillion: 0.9 },
      ),
    ).toBeCloseTo(0.75);
  });
});
