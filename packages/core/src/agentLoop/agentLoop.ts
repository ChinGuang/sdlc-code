/**
 * The agent loop: one agent working on one Task until it hands back a result
 * (one Step). Follows the rules from spike T03 (docs/spikes/nemotron-tools.md):
 * Transcript with reasoning, Token Budget checked every turn, empty answers are
 * failures, 429/5xx retried, and a Working Memory note at the end.
 *
 * The caller (the Orchestrator, T17) decides what a stop means: it stores the
 * note with TaskStore.completeStep and retries the Step on "emptyAnswer" or
 * "apiError".
 */
import {
  ChatApiError,
  type ChatClient,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ContentPart,
  type ExportedImage,
  type ToolCall,
  type Usage,
} from "@sdlc-code/clients";
import { THINKING_OFF } from "../config/agentConfig.js";
import {
  executeToolCall,
  toolMap,
  type AgentTool,
  type ToolMap,
  type ToolOutcome,
  type ToolProblem,
} from "./tools.js";

export type CompletionClient = Pick<ChatClient, "complete">;

export type AgentTask = {
  system: string;
  user: string;
  /** Sent with the user message; only for a model with vision. */
  images?: ExportedImage[];
};

/** One Transcript row; recorded as a Step event (CONTEXT.md "Transcript"). */
export type TranscriptEvent =
  | { type: "message"; role: "system" | "user"; content: string }
  | {
      type: "assistant";
      content: string | null;
      reasoning: string | null;
      toolCalls: ToolCall[];
    }
  | {
      type: "toolResult";
      toolCallId: string;
      name: string;
      content: string;
      problem: ToolProblem | null;
    }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "retry"; status: number; waitSeconds: number }
  | { type: "apiError"; status: number; message: string }
  | { type: "workingMemory"; note: string };

/** Where the Transcript goes; the Orchestrator stores it as Step events. */
export interface Transcript {
  record: (event: TranscriptEvent) => void;
}

/** The Run's Token Budget; the loop stops once nothing remains. */
export interface TokenBudget {
  remaining: () => number;
  spend: (tokens: number) => void;
}

export type AgentLoopOptions = {
  /** Only `complete` is needed, so tests can pass a scripted fake. */
  client: CompletionClient;
  /** The role's model and thinking switch (see requestOptionsFor). */
  request: Pick<ChatRequest, "model" | "extra" | "temperature">;
  tools: AgentTool[];
  /** Model turns allowed in one Step. */
  maxIterations: number;
  transcript?: Transcript;
  budget?: TokenBudget;
  /** Longer tool results are cut, keeping contexts short (spike rule 4). */
  maxToolResultChars?: number;
  /** Attempts per model call when Token Factory returns 429 or 5xx. */
  maxApiAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type StopReason =
  "answered" | "maxIterations" | "tokenBudget" | "emptyAnswer" | "apiError";

export type AgentLoopResult = {
  stopReason: StopReason;
  /** The final answer; null unless stopReason is "answered". */
  answer: string | null;
  /** What was tried, what failed, what to try next (CONTEXT.md "Working Memory"). */
  workingMemory: string;
  /** Model turns, excluding the Working Memory request. */
  iterations: number;
  toolCalls: number;
  failedToolCalls: number;
  /** All tokens spent, including the Working Memory request. */
  usage: Usage;
  /** The Token Factory error, when stopReason is "apiError". */
  error: string | null;
};

/** Runs one Step: an agent with tools, until it answers or hits a limit. */
export interface AgentLoop {
  run: (task: AgentTask) => Promise<AgentLoopResult>;
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 20_000;
const DEFAULT_MAX_API_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const WORKING_MEMORY_MAX_TOKENS = 500;

export const WORKING_MEMORY_PROMPT =
  "Stop working now. Write your Working Memory for whoever continues this Task: what you tried, what failed and why, and what to try next. At most 5 short bullet points, no code.";

export class ChatAgentLoop implements AgentLoop {
  #options: AgentLoopOptions;
  #tools: ToolMap;

  constructor(options: AgentLoopOptions) {
    this.#options = options;
    this.#tools = toolMap(options.tools);
  }

  run = async (task: AgentTask): Promise<AgentLoopResult> => {
    const images = task.images ?? [];
    const messages: ChatMessage[] = [
      { role: "system", content: task.system },
      {
        role: "user",
        content: images.length > 0 ? withImages(task.user, images) : task.user,
      },
    ];
    this.#record({ type: "message", role: "system", content: task.system });
    // The Transcript keeps the text; the images are the design's own exports.
    this.#record({
      type: "message",
      role: "user",
      content:
        images.length > 0
          ? `${task.user}

[${images.length} image${images.length === 1 ? "" : "s"} attached]`
          : task.user,
    });

    const state: LoopState = {
      stopReason: "maxIterations",
      answer: null,
      iterations: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      usage: { promptTokens: 0, completionTokens: 0 },
      error: null,
      lastCalls: [],
      lastPromptTokens: 0,
    };

    try {
      await this.#turns(state, messages);
    } catch (error) {
      // A failed call still ends the Step with a note, so its retry starts informed.
      if (!(error instanceof ChatApiError)) throw error;
      state.stopReason = "apiError";
      state.error = error.message;
      this.#record({
        type: "apiError",
        status: error.status,
        message: error.message,
      });
    }

    const workingMemory = await this.#workingMemory(state, messages);
    this.#record({ type: "workingMemory", note: workingMemory });
    return {
      stopReason: state.stopReason,
      answer: state.answer,
      workingMemory,
      iterations: state.iterations,
      toolCalls: state.toolCalls,
      failedToolCalls: state.failedToolCalls,
      usage: state.usage,
      error: state.error,
    };
  };

  async #turns(state: LoopState, messages: ChatMessage[]): Promise<void> {
    while (state.iterations < this.#options.maxIterations) {
      if (this.#budgetSpent()) {
        state.stopReason = "tokenBudget";
        return;
      }
      const response = await this.#complete({
        messages,
        tools: [...this.#tools.values()].map((tool) => tool.definition),
      });
      state.iterations++;
      this.#record({
        type: "assistant",
        content: response.content,
        reasoning: response.reasoning,
        toolCalls: response.toolCalls,
      });
      this.#spend(state, response);

      if (response.toolCalls.length === 0) {
        const answer = response.content?.trim() ?? "";
        // Spike rule 6: an empty answer is a failed Step, never a result.
        state.stopReason = answer === "" ? "emptyAnswer" : "answered";
        state.answer = answer === "" ? null : answer;
        return;
      }
      // Results the model will never see are wasted work, and later tools write files.
      if (this.#budgetSpent()) {
        state.stopReason = "tokenBudget";
        state.lastCalls = [];
        return;
      }
      await this.#runToolCalls(state, response, messages);
    }
  }

  async #runToolCalls(
    state: LoopState,
    response: ChatResponse,
    messages: ChatMessage[],
  ): Promise<void> {
    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });
    state.lastCalls = [];
    // A reply cut off at the output limit has truncated arguments; running them,
    // even after JSON repair, would act on wrong values.
    const cutOff = response.finishReason === "length";
    for (const call of response.toolCalls) {
      const outcome: ToolOutcome = cutOff
        ? {
            content: `Error: ${call.name} was not run: your reply hit the output token limit, so its arguments are incomplete. Send smaller arguments.`,
            problem: "invalidArguments",
          }
        : await executeToolCall(this.#tools, call);
      const content = this.#truncate(outcome.content);
      state.toolCalls++;
      if (outcome.problem) state.failedToolCalls++;
      state.lastCalls.push({ name: call.name, problem: outcome.problem });
      this.#record({
        type: "toolResult",
        toolCallId: call.id,
        name: call.name,
        content,
        problem: outcome.problem,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  /**
   * Asks the model for its note when another full prompt still fits in the
   * budget; otherwise, or if it fails, writes one from facts.
   */
  async #workingMemory(
    state: LoopState,
    messages: ChatMessage[],
  ): Promise<string> {
    const { budget } = this.#options;
    const needed = state.lastPromptTokens + WORKING_MEMORY_MAX_TOKENS;
    if (
      state.stopReason !== "apiError" &&
      (!budget || budget.remaining() >= needed)
    ) {
      try {
        const response = await this.#complete({
          messages: [
            ...messages,
            { role: "user", content: WORKING_MEMORY_PROMPT },
          ],
          extra: { ...this.#options.request.extra, ...THINKING_OFF },
          maxTokens: WORKING_MEMORY_MAX_TOKENS,
        });
        this.#spend(state, response);
        const note = response.content?.trim();
        if (note) return note;
      } catch (error) {
        if (!(error instanceof ChatApiError)) throw error;
      }
    }
    return fallbackNote(state);
  }

  /** One model call, retrying rate limits and server errors. */
  async #complete(request: Omit<ChatRequest, "model">): Promise<ChatResponse> {
    const attempts = this.#options.maxApiAttempts ?? DEFAULT_MAX_API_ATTEMPTS;
    const sleep =
      this.#options.sleep ??
      ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#options.client.complete({
          ...this.#options.request,
          ...request,
        });
      } catch (error) {
        if (
          !(error instanceof ChatApiError) ||
          !RETRYABLE_STATUS.has(error.status) ||
          attempt >= attempts
        )
          throw error;
        const waitSeconds = error.retryAfterSeconds ?? 2 ** (attempt - 1);
        this.#record({ type: "retry", status: error.status, waitSeconds });
        await sleep(waitSeconds * 1000);
      }
    }
  }

  #spend(state: LoopState, response: ChatResponse): void {
    const { promptTokens, completionTokens } = response.usage;
    state.usage.promptTokens += promptTokens;
    state.usage.completionTokens += completionTokens;
    state.lastPromptTokens = promptTokens;
    this.#options.budget?.spend(promptTokens + completionTokens);
    this.#record({ type: "usage", promptTokens, completionTokens });
  }

  #budgetSpent(): boolean {
    const { budget } = this.#options;
    return budget !== undefined && budget.remaining() <= 0;
  }

  #truncate(content: string): string {
    const limit =
      this.#options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    return content.length <= limit
      ? content
      : `${content.slice(0, limit)}\n…(truncated ${content.length - limit} characters)`;
  }

  #record(event: TranscriptEvent): void {
    this.#options.transcript?.record(event);
  }
}

type LoopState = Omit<AgentLoopResult, "workingMemory"> & {
  /** The tool calls of the latest turn, for the fallback note. */
  lastCalls: Array<{ name: string; problem: ToolProblem | null }>;
  /** Prompt size of the latest call: roughly what one more call will cost. */
  lastPromptTokens: number;
};

const STOP_REASON_TEXT: Record<StopReason, string> = {
  answered: "answered",
  maxIterations: "iteration limit reached",
  tokenBudget: "Token Budget exhausted",
  emptyAnswer: "the model returned an empty answer",
  apiError: "Token Factory error",
};

/** The user message with each image as a data URL after the text. */
function withImages(text: string, images: ExportedImage[]): ContentPart[] {
  return [
    { type: "text", text },
    ...images.map((image): ContentPart => ({
      type: "image_url",
      image_url: {
        url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
      },
    })),
  ];
}

/** A Working Memory note built from facts, when the model cannot write one. */
function fallbackNote(state: LoopState): string {
  const turns = `${state.iterations} model turn${state.iterations === 1 ? "" : "s"}`;
  const calls = `${state.toolCalls} tool call${state.toolCalls === 1 ? "" : "s"} (${state.failedToolCalls} failed)`;
  const last =
    state.lastCalls.length === 0
      ? "none"
      : state.lastCalls
          .map((call) => `${call.name} (${call.problem ?? "ok"})`)
          .join(", ");
  const error = state.error ? ` Error: ${state.error}` : "";
  return `Stopped: ${STOP_REASON_TEXT[state.stopReason]} after ${turns} and ${calls}. Last tool calls: ${last}.${error}`;
}
