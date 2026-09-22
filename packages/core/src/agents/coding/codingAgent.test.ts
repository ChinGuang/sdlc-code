import type {
  ChatRequest,
  ChatResponse,
  ContentPart,
  ToolCall,
} from "@sdlc-code/clients";
import { REACT_NODE, templateFiles } from "@sdlc-code/stack-profiles";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAgentLoop } from "../../agentLoop/agentLoop.js";
import {
  GitWorkspaceManager,
  type WorkspaceManager,
} from "../../workspaces/workspaceManager.js";
import { goodDesign } from "../systemDesign/fixtures/goodDesign.js";
import { goodUiSpec } from "../uiDesign/fixtures/goodUiSpec.js";
import type { ScreenDescription } from "../uiDesign/uiCanvas.js";
import {
  LoopCodingAgent,
  type CodingAgent,
  type CodingAgentOptions,
  type CodingInput,
} from "./codingAgent.js";

// These tests drive real git (many process spawns per test): 2-4s each alone on
// Windows, and far longer when every Vitest project runs at once. The time is
// real work, so this file alone gets a longer timeout than the 5s default.
vi.setConfig({ testTimeout: 60_000 });

type Reply = { content?: string | null; toolCalls?: ToolCall[] };

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

const call = (name: string, args: unknown, id = name): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

/** An agent whose model plays back `replies` and records every request. */
function agentReplaying(
  replies: Reply[],
  options: Partial<CodingAgentOptions> = {},
) {
  const requests: ChatRequest[] = [];
  const queue = [...replies];
  // Tests depend on the interface; only this factory knows the class.
  const agent: CodingAgent = new LoopCodingAgent({
    createLoop: (tools) =>
      new ChatAgentLoop({
        client: {
          complete: async (request): Promise<ChatResponse> => {
            requests.push(structuredClone(request));
            const next = queue.shift() ?? { content: "- nothing more" };
            const toolCalls = next.toolCalls ?? [];
            return {
              content: next.content ?? null,
              reasoning: null,
              toolCalls,
              finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
              usage: { promptTokens: 500, completionTokens: 50 },
              latencyMs: 1,
            };
          },
        },
        request: { model: "nvidia/nemotron-3-super-120b-a12b" },
        tools,
        maxIterations: 8,
      }),
    ...options,
  });
  return { agent, requests };
}

const design = goodDesign();

/** A Workspace holding the template, as WorkspaceManager.openWorkspace gives it. */
async function workspaces(): Promise<WorkspaceManager> {
  const root = mkdtempSync(join(tmpdir(), "sdlc-coding-"));
  folders.push(root);
  const manager: WorkspaceManager = new GitWorkspaceManager({
    repoDir: join(root, "run.git"),
    runBranch: "sdlc/todo-app",
    workspacesDir: join(root, "workspaces"),
  });
  await manager.startRun({
    scaffold: templateFiles(REACT_NODE),
    message: "Scaffold",
  });
  return manager;
}

function input(
  workspaceDir: string,
  overrides: Partial<CodingInput> = {},
): CodingInput {
  return {
    side: "backend",
    profile: REACT_NODE,
    projectRequest: "A todo app",
    slice: design.slicePlan[1]!,
    documents: {
      systemDesign: "# System Design",
      slicePlan: design.slicePlan,
      apiContract: design.apiContract,
      uiSpec: goodUiSpec(),
    },
    issueReports: [],
    workingMemory: null,
    capabilities: { vision: false, penpotMcp: false },
    screenImages: new Map(),
    workspaceDir,
    penpotPage: null,
    ...overrides,
  };
}

const toolNames = (request: ChatRequest) =>
  (request.tools ?? []).map((tool) => tool.name);

describe("LoopCodingAgent", () => {
  it("builds its side in its Workspace and reports what it changed", async () => {
    const manager = await workspaces();
    const backend = await manager.openWorkspace("slice-2", "backend");
    const { agent } = agentReplaying([
      { toolCalls: [call("read_file", { path: "server/app.ts" })] },
      {
        toolCalls: [
          call("write_file", {
            path: "server/todos.ts",
            contents: "export const todos = [];\n",
          }),
        ],
      },
      { content: "Added the todos module, tested by server/todos.test.ts." },
    ]);

    const result = await agent.code(input(backend.dir));

    expect(result.summary).toBe(
      "Added the todos module, tested by server/todos.test.ts.",
    );
    expect(result.changes).toEqual([
      { path: "server/todos.ts", kind: "written" },
    ]);
    expect(readFileSync(join(backend.dir, "server/todos.ts"), "utf8")).toBe(
      "export const todos = [];\n",
    );
  });

  it("reads several files in one turn, reporting a bad one without failing the rest", async () => {
    const manager = await workspaces();
    const backend = await manager.openWorkspace("slice-2", "backend");
    const { agent, requests } = agentReplaying([
      {
        toolCalls: [
          call("read_files", {
            paths: ["server/app.ts", ".env", "server/missing.ts"],
          }),
        ],
      },
      { content: "Read them." },
    ]);

    await agent.code(input(backend.dir));

    const result = requests[1]!.messages.find(
      (message) => message.role === "tool",
    )!.content as string;
    expect(result).toContain("=== server/app.ts ===\nimport express");
    expect(result).toContain("=== .env ===\nError:");
    expect(result).toContain(
      '=== server/missing.ts ===\nError: No file "server/missing.ts".',
    );
  });

  it("flags a Step that answered without changing anything", async () => {
    const manager = await workspaces();
    const backend = await manager.openWorkspace("slice-2", "backend");
    const { agent } = agentReplaying([{ content: "All done!" }]);

    const result = await agent.code(input(backend.dir));

    expect(result.summary).toBe("All done!");
    expect(result.problem).toBe("noChanges");
  });

  it("flags a Step whose loop stopped before answering", async () => {
    const manager = await workspaces();
    const backend = await manager.openWorkspace("slice-2", "backend");
    const { agent } = agentReplaying([{ content: "" }]);

    const result = await agent.code(input(backend.dir));

    expect(result.loop.stopReason).toBe("emptyAnswer");
    expect(result.problem).toBe("notAnswered");
  });

  it("cannot write outside its Workspace, or the other side's files", async () => {
    const manager = await workspaces();
    const backend = await manager.openWorkspace("slice-2", "backend");
    const { agent, requests } = agentReplaying([
      {
        toolCalls: [
          call("write_file", { path: "../escape.ts", contents: "x" }, "a"),
          call("write_file", { path: "src/App.tsx", contents: "x" }, "b"),
          call("write_file", { path: ".git/config", contents: "x" }, "c"),
          call("write_file", { path: ".env", contents: "KEY=x" }, "d"),
        ],
      },
      { content: "Could not write those files." },
    ]);

    const result = await agent.code(input(backend.dir));

    expect(result.changes).toEqual([]);
    expect(result.loop.failedToolCalls).toBe(4);
    expect(existsSync(join(backend.dir, "..", "escape.ts"))).toBe(false);
    expect(existsSync(join(backend.dir, ".env"))).toBe(false);
    const errors = requests[1]!.messages.filter(
      (message) => message.role === "tool",
    );
    expect(errors.map((message) => message.content)).toEqual([
      expect.stringContaining("not a path inside the Workspace"),
      expect.stringContaining('You may not write "src/App.tsx"'),
      expect.stringContaining("which agents do not touch"),
      expect.stringContaining("would hold secrets"),
    ]);
  });

  it("offers the file tools only, without penpotMcp", async () => {
    const manager = await workspaces();
    const frontend = await manager.openWorkspace("slice-2", "frontend");
    const { agent, requests } = agentReplaying([{ content: "done" }], {
      canvas: { describeScreen: async () => null },
    });

    await agent.code(
      input(frontend.dir, { side: "frontend", penpotPage: "#1" }),
    );

    expect(toolNames(requests[0]!)).toEqual([
      "list_files",
      "read_file",
      "read_files",
      "search_files",
      "write_file",
      "edit_file",
      "delete_file",
    ]);
  });

  it("reads the live Penpot design with penpotMcp, a canvas and the Run's page", async () => {
    const manager = await workspaces();
    const frontend = await manager.openWorkspace("slice-2", "frontend");
    const asked: string[][] = [];
    const described: ScreenDescription = {
      name: "Todo list",
      width: 1280,
      height: 800,
      elements: [
        {
          type: "rect",
          name: "button: Add",
          text: null,
          x: 560,
          y: 128,
          width: 120,
          height: 48,
          fill: "#2563EB",
        },
      ],
    };
    const { agent, requests } = agentReplaying(
      [
        { toolCalls: [call("inspect_screen", { screen: "Todo list" })] },
        { content: "Built the list screen." },
      ],
      {
        canvas: {
          describeScreen: async (page, screen) => {
            asked.push([page, screen]);
            return described;
          },
        },
      },
    );

    await agent.code(
      input(frontend.dir, {
        side: "frontend",
        penpotPage: "#1 Todo app",
        capabilities: { vision: false, penpotMcp: true },
      }),
    );

    expect(toolNames(requests[0]!)).toContain("inspect_screen");
    expect(asked).toEqual([["#1 Todo app", "Todo list"]]);
    const result = requests[1]!.messages.find(
      (message) => message.role === "tool",
    );
    expect(result?.content).toContain(
      "- rect button: Add at (560, 128) 120x48 fill #2563EB",
    );
  });

  it("offers no Penpot tool when there is no page to read, whatever the model can do", async () => {
    const manager = await workspaces();
    const frontend = await manager.openWorkspace("slice-2", "frontend");
    const { agent, requests } = agentReplaying([{ content: "done" }], {
      canvas: { describeScreen: async () => null },
    });

    await agent.code(
      input(frontend.dir, {
        side: "frontend",
        capabilities: { vision: false, penpotMcp: true },
      }),
    );

    expect(toolNames(requests[0]!)).not.toContain("inspect_screen");
    expect(requests[0]!.messages[0]!.content).not.toContain("inspect_screen");
  });

  it("sends the Slice's board PNGs to a model with vision", async () => {
    const manager = await workspaces();
    const frontend = await manager.openWorkspace("slice-2", "frontend");
    const { agent, requests } = agentReplaying([{ content: "done" }]);

    await agent.code(
      input(frontend.dir, {
        side: "frontend",
        capabilities: { vision: true, penpotMcp: false },
        screenImages: new Map([
          ["Todo list", { bytes: Buffer.from("png"), mimeType: "image/png" }],
        ]),
      }),
    );

    const content = requests[0]!.messages[1]!.content as ContentPart[];
    expect(content.map((part) => part.type)).toEqual(["text", "image_url"]);
  });

  it("runs backend and frontend at the same time, and their work merges", async () => {
    const manager = await workspaces();
    const backend = await manager.openWorkspace("slice-2", "backend");
    const frontend = await manager.openWorkspace("slice-2", "frontend");
    const backendAgent = agentReplaying([
      {
        toolCalls: [
          call("write_file", {
            path: "server/todos.ts",
            contents: "export const todos = [];\n",
          }),
        ],
      },
      { content: "Backend done." },
    ]).agent;
    const frontendAgent = agentReplaying([
      {
        toolCalls: [
          call("write_file", {
            path: "src/TodoList.tsx",
            contents: "export const TodoList = () => null;\n",
          }),
        ],
      },
      { content: "Frontend done." },
    ]).agent;

    const results = await Promise.all([
      backendAgent.code(input(backend.dir)),
      frontendAgent.code(input(frontend.dir, { side: "frontend" })),
    ]);
    await manager.saveWorkspace(backend, "Backend: todos");
    await manager.saveWorkspace(frontend, "Frontend: todo list");
    const merged = await manager.mergeSlice("slice-2", [backend, frontend]);

    expect(results.map((result) => result.summary)).toEqual([
      "Backend done.",
      "Frontend done.",
    ]);
    expect(merged.status).toBe("merged");
    if (merged.status !== "merged") return;
    const paths = (await manager.readFiles(merged.commit)).map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["server/todos.ts", "src/TodoList.tsx"]),
    );
  });
});
