/**
 * Chat completions against Nebius Token Factory (OpenAI-compatible API).
 * Spike quality: covers what the agent loop needs — tools, structured output, usage.
 */

export const TOKEN_FACTORY_DEFAULT_BASE_URL =
  "https://api.tokenfactory.nebius.com/v1";

export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Force a specific tool; omit for "auto". */
  toolChoice?: { name: string };
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxTokens?: number;
  /** Provider-specific fields merged into the request body. */
  extra?: Record<string, unknown>;
};

export type Usage = { promptTokens: number; completionTokens: number };

export type ChatResponse = {
  content: string | null;
  reasoning: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
  latencyMs: number;
};

export type ChatClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

/** Chat completions used by agents. */
export interface ChatClient {
  complete: (request: ChatRequest) => Promise<ChatResponse>;
  listModels: () => Promise<ModelInfo[]>;
}

export class ChatApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    retryAfterSeconds: number | null,
    message: string,
  ) {
    super(message);
    this.name = "ChatApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type RawCompletion = {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** ChatClient over the Token Factory REST API. */
export class TokenFactoryChatClient implements ChatClient {
  #apiKey: string;
  #baseUrl: string;
  #fetch: typeof fetch;
  #now: () => number;

  constructor(options: ChatClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? TOKEN_FACTORY_DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    );
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  complete = async (request: ChatRequest): Promise<ChatResponse> => {
    const started = this.#now();
    const raw = await this.#request<RawCompletion>(
      "POST",
      "/chat/completions",
      toRequestBody(request),
    );
    return fromCompletion(raw, this.#now() - started);
  };

  listModels = async (): Promise<ModelInfo[]> => {
    const raw = await this.#request<{ data?: RawModel[] }>(
      "GET",
      "/models?verbose=true",
    );
    return (raw.data ?? []).map(toModelInfo);
  };

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new ChatApiError(
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        `Token Factory ${response.status}: ${errorMessage(text)}`,
      );
    }
    return JSON.parse(text) as T;
  }
}

/** A model offered by Token Factory, from GET /models?verbose=true. */
export type ModelInfo = {
  id: string;
  contextLength: number | null;
  pricing: Pricing | null;
  features: string[];
};

type RawModel = {
  id: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_features?: string[];
};

function toModelInfo(model: RawModel): ModelInfo {
  const prompt = Number(model.pricing?.prompt);
  const completion = Number(model.pricing?.completion);
  const priced = Number.isFinite(prompt) && Number.isFinite(completion);
  return {
    id: model.id,
    contextLength: model.context_length ?? null,
    pricing: priced
      ? {
          // API prices are per token; round away float noise from the x1e6.
          promptPerMillion: Number((prompt * 1_000_000).toFixed(6)),
          completionPerMillion: Number((completion * 1_000_000).toFixed(6)),
        }
      : null,
    features: model.supported_features ?? [],
  };
}

function toRequestBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
  };
  if (request.tools)
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: tool,
    }));
  if (request.toolChoice)
    body.tool_choice = {
      type: "function",
      function: { name: request.toolChoice.name },
    };
  if (request.jsonSchema)
    body.response_format = {
      type: "json_schema",
      json_schema: request.jsonSchema,
    };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  return { ...body, ...request.extra };
}

function fromCompletion(raw: RawCompletion, latencyMs: number): ChatResponse {
  const choice = raw.choices?.[0];
  const message = choice?.message ?? {};
  return {
    content: message.content ?? null,
    reasoning: message.reasoning_content ?? message.reasoning ?? null,
    toolCalls: (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    finishReason: choice?.finish_reason ?? null,
    usage: {
      promptTokens: raw.usage?.prompt_tokens ?? 0,
      completionTokens: raw.usage?.completion_tokens ?? 0,
    },
    latencyMs,
  };
}

function errorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: string | { message?: string };
      detail?: unknown;
    };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.detail !== undefined) return JSON.stringify(parsed.detail);
  } catch {
    // not JSON: fall through to the raw text
  }
  return text.slice(0, 500);
}

export type ParsedArguments =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** Parses a tool call's JSON arguments; models sometimes emit malformed JSON. */
export function parseToolArguments(raw: string): ParsedArguments {
  if (raw.trim() === "") return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return { ok: false, error: "arguments must be a JSON object" };
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${String(error)}` };
  }
}

export type Pricing = {
  promptPerMillion: number;
  completionPerMillion: number;
};

export function costUsd(usage: Usage, pricing: Pricing): number {
  return (
    (usage.promptTokens * pricing.promptPerMillion +
      usage.completionTokens * pricing.completionPerMillion) /
    1_000_000
  );
}
