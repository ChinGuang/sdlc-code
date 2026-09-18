/**
 * Minimal tool-calling loop used by the spike to measure long runs.
 * T08 builds the real agent loop (Transcript, Working Memory, Token Budget) from this.
 */
import {
  parseToolArguments,
  type ChatClient,
  type ChatMessage,
  type ToolDefinition,
  type Usage,
} from "@sdlc-code/clients";

export type CompletionClient = Pick<ChatClient, "complete">;

export type ToolHandler = (
  args: Record<string, unknown>,
) => string | Promise<string>;

export type LoopTools = Record<
  string,
  { definition: ToolDefinition; handler: ToolHandler }
>;

export type LoopTask = { system: string; user: string };

export type LoopResult = {
  stopReason: "answered" | "max_iterations";
  finalContent: string | null;
  iterations: number;
  toolCallCount: number;
  parallelTurns: number;
  malformedArguments: number;
  unknownTools: number;
  usage: Usage;
  latencyMs: number;
  reasoningChars: number;
  messages: ChatMessage[];
};

export type ChatToolLoopOptions = {
  /** Only `complete` is needed, so tests and callers can pass a narrow fake. */
  client: CompletionClient;
  model: string;
  tools: LoopTools;
  maxIterations: number;
  temperature?: number;
  extra?: Record<string, unknown>;
};

/** Runs a task to completion with tool calls. */
export interface ToolLoop {
  run: (task: LoopTask) => Promise<LoopResult>;
}

export class ChatToolLoop implements ToolLoop {
  #options: ChatToolLoopOptions;

  constructor(options: ChatToolLoopOptions) {
    this.#options = options;
  }

  run = async (task: LoopTask): Promise<LoopResult> => {
    const { client, model, tools, maxIterations, temperature, extra } =
      this.#options;
    const messages: ChatMessage[] = [
      { role: "system", content: task.system },
      { role: "user", content: task.user },
    ];
    const result: LoopResult = {
      stopReason: "max_iterations",
      finalContent: null,
      iterations: 0,
      toolCallCount: 0,
      parallelTurns: 0,
      malformedArguments: 0,
      unknownTools: 0,
      usage: { promptTokens: 0, completionTokens: 0 },
      latencyMs: 0,
      reasoningChars: 0,
      messages,
    };

    while (result.iterations < maxIterations) {
      const response = await client.complete({
        model,
        messages,
        tools: Object.values(tools).map((tool) => tool.definition),
        temperature,
        extra,
      });
      result.iterations++;
      result.usage.promptTokens += response.usage.promptTokens;
      result.usage.completionTokens += response.usage.completionTokens;
      result.latencyMs += response.latencyMs;
      result.reasoningChars += response.reasoning?.length ?? 0;

      if (response.toolCalls.length === 0) {
        result.stopReason = "answered";
        result.finalContent = response.content;
        return result;
      }

      result.toolCallCount += response.toolCalls.length;
      if (response.toolCalls.length > 1) result.parallelTurns++;
      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      for (const call of response.toolCalls) {
        const { content, problem } = await this.#execute(
          call.name,
          call.arguments,
        );
        if (problem === "malformed") result.malformedArguments++;
        if (problem === "unknown_tool") result.unknownTools++;
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }
    return result;
  };

  async #execute(name: string, rawArguments: string): Promise<ToolOutcome> {
    const tool = this.#options.tools[name];
    if (!tool)
      return {
        content: `Error: unknown tool ${name}`,
        problem: "unknown_tool",
      };
    const parsed = parseToolArguments(rawArguments);
    if (!parsed.ok)
      return {
        content: `Error: invalid arguments (${parsed.error})`,
        problem: "malformed",
      };
    try {
      return { content: await tool.handler(parsed.value), problem: null };
    } catch (error) {
      return {
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        problem: null,
      };
    }
  }
}

type ToolOutcome = {
  content: string;
  problem: "malformed" | "unknown_tool" | null;
};
