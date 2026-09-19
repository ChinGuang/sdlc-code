/**
 * Tools an agent can call. Each tool declares its input once, as a zod schema:
 * the model sees it as JSON Schema, and arguments are validated against it
 * before the tool runs.
 */
import {
  parseToolArguments,
  type ToolCall,
  type ToolDefinition,
} from "@sdlc-code/clients";
import { z } from "zod";

export type AgentTool = {
  definition: ToolDefinition;
  /** Validates `args` and runs the tool; throws z.ZodError on invalid input. */
  run: (args: Record<string, unknown>) => Promise<string>;
};

export function defineTool<Input extends z.ZodObject>(spec: {
  name: string;
  description: string;
  input: Input;
  run: (args: z.infer<Input>) => string | Promise<string>;
}): AgentTool {
  // The model needs the schema itself, not which JSON Schema dialect it uses.
  const parameters: Record<string, unknown> = z.toJSONSchema(spec.input);
  delete parameters.$schema;
  return {
    definition: {
      name: spec.name,
      description: spec.description,
      parameters,
    },
    run: async (args) =>
      spec.run(spec.input.parse(parseJsonStrings(spec.input, args))),
  };
}

/**
 * Nemotron sometimes sends a nested object or array as a JSON string (seen live
 * in T09). Where the schema expects an object, record or array, parse it.
 */
function parseJsonStrings(
  schema: z.ZodObject,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      const field = schema.shape[key];
      if (typeof value !== "string" || !field || !expectsStructure(field))
        return [key, value];
      try {
        const parsed: unknown = JSON.parse(value);
        return [
          key,
          typeof parsed === "object" && parsed !== null ? parsed : value,
        ];
      } catch {
        return [key, value];
      }
    }),
  );
}

function expectsStructure(field: z.ZodType): boolean {
  const inner =
    field instanceof z.ZodOptional || field instanceof z.ZodDefault
      ? (field.unwrap() as z.ZodType)
      : field;
  return (
    inner instanceof z.ZodObject ||
    inner instanceof z.ZodRecord ||
    inner instanceof z.ZodArray
  );
}

export type ToolMap = ReadonlyMap<string, AgentTool>;

export function toolMap(tools: AgentTool[]): ToolMap {
  const map = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (map.has(tool.definition.name))
      throw new Error(`duplicate tool name "${tool.definition.name}"`);
    map.set(tool.definition.name, tool);
  }
  return map;
}

export type ToolProblem = "unknownTool" | "invalidArguments" | "toolError";

export type ToolOutcome = { content: string; problem: ToolProblem | null };

/** Runs one tool call. Every failure becomes an error message for the model. */
export async function executeToolCall(
  tools: ToolMap,
  call: ToolCall,
): Promise<ToolOutcome> {
  const tool = tools.get(call.name);
  if (!tool)
    return {
      content: `Error: unknown tool "${call.name}". Available tools: ${[...tools.keys()].join(", ")}.`,
      problem: "unknownTool",
    };
  const parsed = parseToolArguments(call.arguments);
  if (!parsed.ok)
    return {
      content: `Error: invalid arguments for ${call.name}: ${parsed.error}`,
      problem: "invalidArguments",
    };
  try {
    return { content: await tool.run(parsed.value), problem: null };
  } catch (error) {
    if (error instanceof z.ZodError)
      return {
        content: `Error: invalid arguments for ${call.name}:\n${z.prettifyError(error)}`,
        problem: "invalidArguments",
      };
    return {
      content: `Error: ${call.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      problem: "toolError",
    };
  }
}
