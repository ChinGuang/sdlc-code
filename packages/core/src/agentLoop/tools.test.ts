import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, executeToolCall, toolMap } from "./tools.js";

const readFile = defineTool({
  name: "read_file",
  description: "Read a file",
  input: z.object({
    path: z.string().describe("Repo-relative path"),
    maxLines: z.number().int().positive().optional(),
  }),
  run: ({ path, maxLines }) => `${path}:${maxLines ?? "all"}`,
});

const failing = defineTool({
  name: "explode",
  description: "Always throws",
  input: z.object({}),
  run: () => {
    throw new Error("disk on fire");
  },
});

const tools = toolMap([readFile, failing]);
const call = (name: string, args: string) => ({
  id: "c1",
  name,
  arguments: args,
});

describe("defineTool", () => {
  it("derives the JSON Schema the model sees from the zod input", () => {
    expect(readFile.definition).toEqual({
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path" },
          maxLines: {
            type: "integer",
            exclusiveMinimum: 0,
            maximum: 9007199254740991,
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    });
  });
});

describe("toolMap", () => {
  it("rejects two tools with the same name", () => {
    expect(() => toolMap([readFile, readFile])).toThrow(
      /duplicate tool name "read_file"/,
    );
  });
});

describe("executeToolCall", () => {
  it("runs the tool with validated, typed arguments", async () => {
    expect(
      await executeToolCall(
        tools,
        call("read_file", '{"path":"a.ts","maxLines":5}'),
      ),
    ).toEqual({ content: "a.ts:5", problem: null });
  });

  it("treats empty arguments as {}", async () => {
    expect(await executeToolCall(tools, call("explode", ""))).toMatchObject({
      problem: "toolError",
    });
  });

  it("reports an unknown tool with the tools that exist", async () => {
    expect(await executeToolCall(tools, call("rm_rf", "{}"))).toEqual({
      content:
        'Error: unknown tool "rm_rf". Available tools: read_file, explode.',
      problem: "unknownTool",
    });
  });

  it("reports malformed JSON", async () => {
    const outcome = await executeToolCall(tools, call("read_file", '{"path":'));

    expect(outcome.problem).toBe("invalidArguments");
    expect(outcome.content).toMatch(
      /^Error: invalid arguments for read_file: invalid JSON/,
    );
  });

  it("reports arguments that do not match the schema", async () => {
    const outcome = await executeToolCall(
      tools,
      call("read_file", '{"path":3,"extra":true}'),
    );

    expect(outcome.problem).toBe("invalidArguments");
    expect(outcome.content).toMatch(/^Error: invalid arguments for read_file:/);
    expect(outcome.content).toMatch(/path/);
  });

  it("returns a thrown error to the model instead of crashing the loop", async () => {
    expect(await executeToolCall(tools, call("explode", "{}"))).toEqual({
      content: "Error: explode failed: disk on fire",
      problem: "toolError",
    });
  });
});
