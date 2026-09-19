/**
 * Server-Sent Events parsing and response assembly for streamed chat completions.
 * Shapes verified against Token Factory on 2026-09-19 (see fixtures/streamToolCall.sse).
 */
import type { ChatResponse, Usage } from "./chatClient.js";

export type ChatStreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  /** A tool call has started; its arguments arrive in the final `done` response. */
  | { type: "tool_call"; id: string; name: string }
  | { type: "done"; response: ChatResponse };

/** The stream broke: cut off, reported an error, sent bad data, or omitted usage. */
export class ChatStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatStreamError";
  }
}

type RawChunk = {
  error?: string | { message?: string };
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

type PartialToolCall = {
  id: string;
  name: string;
  arguments: string;
  announced: boolean;
};

export type StreamState = {
  content: string;
  reasoning: string;
  toolCalls: Map<number, PartialToolCall>;
  finishReason: string | null;
  usage: Usage | null;
};

export function createStreamState(): StreamState {
  return {
    content: "",
    reasoning: "",
    toolCalls: new Map(),
    finishReason: null,
    usage: null,
  };
}

/** Folds one chunk into the state and returns the events to emit for it. */
export function applyStreamChunk(
  state: StreamState,
  chunk: RawChunk,
): ChatStreamEvent[] {
  if (chunk.error !== undefined) {
    const message =
      typeof chunk.error === "string" ? chunk.error : chunk.error.message;
    throw new ChatStreamError(
      `Token Factory stream error: ${message ?? "unknown"}`,
    );
  }
  const events: ChatStreamEvent[] = [];
  if (chunk.usage) {
    state.usage = {
      promptTokens: chunk.usage.prompt_tokens ?? 0,
      completionTokens: chunk.usage.completion_tokens ?? 0,
    };
  }
  // We never request n > 1, so only the first choice matters.
  const choice = chunk.choices?.[0];
  if (!choice) return events;
  const delta = choice.delta ?? {};

  // Token Factory sends each reasoning piece twice (`reasoning` and `reasoning_content`).
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (reasoning) {
    state.reasoning += reasoning;
    events.push({ type: "reasoning", text: reasoning });
  }
  if (delta.content) {
    state.content += delta.content;
    events.push({ type: "content", text: delta.content });
  }
  for (const part of delta.tool_calls ?? []) {
    const call = state.toolCalls.get(part.index) ?? {
      id: "",
      name: "",
      arguments: "",
      announced: false,
    };
    if (part.id) call.id = part.id;
    if (part.function?.name) call.name += part.function.name;
    if (part.function?.arguments) call.arguments += part.function.arguments;
    if (!call.announced && call.name) {
      call.announced = true;
      events.push({ type: "tool_call", id: call.id, name: call.name });
    }
    state.toolCalls.set(part.index, call);
  }
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  return events;
}

export function finishStream(
  state: StreamState,
  latencyMs: number,
): ChatResponse {
  // We always ask for usage; without it the Token Budget would silently count zero.
  if (!state.usage)
    throw new ChatStreamError("Token Factory stream ended without token usage");
  return {
    content: state.content === "" ? null : state.content,
    reasoning: state.reasoning === "" ? null : state.reasoning,
    toolCalls: [...state.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, { id, name, arguments: args }]) => ({
        id,
        name,
        arguments: args,
      })),
    finishReason: state.finishReason,
    usage: state.usage,
    latencyMs,
  };
}

/**
 * Yields each event's JSON payload until `[DONE]`. Follows the SSE rules we rely on:
 * CRLF or LF line endings, `:` comment lines, multi-line `data:` fields joined by "\n",
 * and a last event without a trailing blank line. Throws if `[DONE]` never arrives.
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  function* takeEvents(final: boolean): Generator<RawChunk> {
    // A "\r" split from its "\n" across chunks is rejoined on the next pass.
    buffer = buffer.replaceAll("\r\n", "\n");
    let boundary: number;
    while (!done && (boundary = buffer.indexOf("\n\n")) !== -1) {
      yield* parseEvent(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
    if (final && !done && buffer.trim() !== "") {
      yield* parseEvent(buffer);
      buffer = "";
    }
  }

  function* parseEvent(event: string): Generator<RawChunk> {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
      .join("\n");
    if (data === "") return;
    if (data.trim() === "[DONE]") {
      done = true;
      return;
    }
    try {
      yield JSON.parse(data) as RawChunk;
    } catch {
      throw new ChatStreamError(
        `Token Factory sent malformed stream data: ${data.slice(0, 200)}`,
      );
    }
  }

  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    yield* takeEvents(false);
    if (done) return;
  }
  buffer += decoder.decode();
  yield* takeEvents(true);
  if (!done)
    throw new ChatStreamError("Token Factory stream ended before [DONE]");
}
