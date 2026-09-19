/**
 * Server-Sent Events parsing and response assembly for streamed chat completions.
 * Shapes verified against Token Factory on 2026-09-19 (see fixtures/streamToolCall.sse).
 */
import type { ToolCall, Usage } from "./chatClient.js";

export type ChatStreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "done"; response: StreamedResponse };

/** Same shape as ChatResponse (declared here to avoid a circular type import). */
export type StreamedResponse = {
  content: string | null;
  reasoning: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
  latencyMs: number;
};

type RawChunk = {
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

export type StreamState = {
  content: string;
  reasoning: string;
  toolCalls: Map<number, ToolCall>;
  finishReason: string | null;
  usage: Usage;
};

export function createStreamState(): StreamState {
  return {
    content: "",
    reasoning: "",
    toolCalls: new Map(),
    finishReason: null,
    usage: { promptTokens: 0, completionTokens: 0 },
  };
}

/** Folds one chunk into the state and returns the events to emit for it. */
export function applyStreamChunk(
  state: StreamState,
  chunk: RawChunk,
): ChatStreamEvent[] {
  const events: ChatStreamEvent[] = [];
  if (chunk.usage) {
    state.usage = {
      promptTokens: chunk.usage.prompt_tokens ?? 0,
      completionTokens: chunk.usage.completion_tokens ?? 0,
    };
  }
  for (const choice of chunk.choices ?? []) {
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
      };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name += part.function.name;
      if (part.function?.arguments) call.arguments += part.function.arguments;
      state.toolCalls.set(part.index, call);
    }
    if (choice.finish_reason) state.finishReason = choice.finish_reason;
  }
  return events;
}

export function finishStream(
  state: StreamState,
  latencyMs: number,
): StreamedResponse {
  return {
    content: state.content === "" ? null : state.content,
    reasoning: state.reasoning === "" ? null : state.reasoning,
    toolCalls: [...state.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call),
    finishReason: state.finishReason,
    usage: state.usage,
    latencyMs,
  };
}

/** Yields the JSON payload of each `data:` event, stopping at `[DONE]`. */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    // SSE allows CRLF line endings; normalise so events always end in "\n\n".
    // A "\r" split from its "\n" across chunks is harmless: "\r\n" is rejoined next time.
    buffer = (buffer + decoder.decode(bytes, { stream: true })).replaceAll(
      "\r\n",
      "\n",
    );
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        if (data) yield JSON.parse(data) as RawChunk;
      }
    }
  }
}
