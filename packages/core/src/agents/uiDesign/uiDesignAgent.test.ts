import type { ChatRequest, ChatResponse, ToolCall } from "@sdlc-code/clients";
import { PenpotError } from "@sdlc-code/clients";
import { describe, expect, it } from "vitest";
import { ChatAgentLoop } from "../../agentLoop/agentLoop.js";
import { goodDesign } from "../systemDesign/fixtures/goodDesign.js";
import { goodUiSpec } from "./fixtures/goodUiSpec.js";
import {
  LoopUiDesignAgent,
  SUBMIT_UI_SPEC,
  type UiDesignAgent,
} from "./uiDesignAgent.js";
import type { DrawScreenRequest, UiCanvas } from "./uiCanvas.js";

type Reply = { content: string | null; toolCalls: ToolCall[] };

/** A canvas that records what it was asked to draw. */
function fakeCanvas(overrides: Partial<UiCanvas> = {}) {
  const drawn: DrawScreenRequest[] = [];
  const exported: string[] = [];
  const canvas: UiCanvas = {
    checkConnection: async () => ({ file: "sdlc-code runs", page: "Page 1" }),
    ensurePage: async () => ({ pageId: "page-1", created: true }),
    drawScreen: async (request) => {
      drawn.push(request);
      return {
        boardId: `board-${drawn.length}`,
        name: `Screen: ${request.screen.name}`,
      };
    },
    exportBoard: async (boardId) => {
      exported.push(boardId);
      return { bytes: Buffer.from("png"), mimeType: "image/png" };
    },
    ...overrides,
  };
  return { canvas, drawn, exported };
}

function agentReplaying(replies: Reply[], canvas: UiCanvas) {
  const requests: ChatRequest[] = [];
  const queue = [...replies];
  // Tests depend on the interface; only this factory knows the class.
  const agent: UiDesignAgent = new LoopUiDesignAgent({
    canvas,
    createLoop: (tools) =>
      new ChatAgentLoop({
        client: {
          complete: async (request): Promise<ChatResponse> => {
            requests.push(structuredClone(request));
            const next = queue.shift() ?? {
              content: "Working Memory note",
              toolCalls: [],
            };
            return {
              ...next,
              reasoning: null,
              finishReason: next.toolCalls.length > 0 ? "tool_calls" : "stop",
              usage: { promptTokens: 800, completionTokens: 150 },
              latencyMs: 1,
            };
          },
        },
        request: { model: "nvidia/nemotron-3-super-120b-a12b" },
        tools,
        maxIterations: 6,
      }),
  });
  return { agent, requests };
}

let callId = 0;
const submit = (spec: unknown): Reply => ({
  content: null,
  toolCalls: [
    {
      id: `call-${++callId}`,
      name: SUBMIT_UI_SPEC,
      arguments: JSON.stringify(spec),
    },
  ],
});
const answer = (content = "Two screens."): Reply => ({
  content,
  toolCalls: [],
});

const design = goodDesign();
const input = {
  projectRequest: "Build a todo app.",
  pageName: "#run-1 Todo app",
  slicePlan: design.slicePlan,
  apiContract: design.apiContract,
};
const lastToolMessage = (request: ChatRequest | undefined) =>
  request?.messages.at(-1)?.content ?? "";

describe("LoopUiDesignAgent", () => {
  it("accepts a UI Spec, then draws and exports every screen on the Run's page", async () => {
    const { canvas, drawn, exported } = fakeCanvas();
    const { agent } = agentReplaying([submit(goodUiSpec()), answer()], canvas);

    const { spec, screens, loop } = await agent.design(input);

    expect(loop.stopReason).toBe("answered");
    expect(spec).toEqual(goodUiSpec());
    expect(
      drawn.map((request) => [request.index, request.screen.name]),
    ).toEqual([
      [0, "Health"],
      [1, "Todo list"],
    ]);
    expect(drawn[0]?.pageName).toBe("#run-1 Todo app");
    expect(drawn[0]?.tokens).toEqual(goodUiSpec().tokens);
    expect(exported).toEqual(["board-1", "board-2"]);
    expect(screens).toEqual([
      {
        name: "Health",
        boardId: "board-1",
        export: { bytes: Buffer.from("png"), mimeType: "image/png" },
      },
      {
        name: "Todo list",
        boardId: "board-2",
        export: { bytes: Buffer.from("png"), mimeType: "image/png" },
      },
    ]);
  });

  it("gives the model the Slice Plan and the API Contract operations", async () => {
    const { canvas } = fakeCanvas();
    const { agent, requests } = agentReplaying(
      [submit(goodUiSpec()), answer()],
      canvas,
    );

    await agent.design(input);

    const user = requests[0]?.messages[1]?.content ?? "";
    expect(requests[0]?.messages[0]?.content).toMatch(/UI Design Agent/);
    expect(user).toMatch(/Slice Plan:\n- Walking Skeleton: .*\n- Todos: /);
    expect(user).toMatch(
      /API Contract operations:\n- GET \/health\n- GET \/todos/,
    );
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      SUBMIT_UI_SPEC,
    ]);
  });

  it("returns validation problems to the model, which fixes them", async () => {
    const broken = goodUiSpec();
    broken.screens[1]!.endpoints.push("DELETE /todos/{id}");
    const { canvas, drawn } = fakeCanvas();
    const { agent, requests } = agentReplaying(
      [submit(broken), submit(goodUiSpec()), answer()],
      canvas,
    );

    const { spec, loop } = await agent.design(input);

    expect(lastToolMessage(requests[1])).toMatch(
      /UI Spec rejected[\s\S]*DELETE \/todos\/\{id\} is not in the API Contract/,
    );
    expect(loop.failedToolCalls).toBe(1);
    expect(spec).toEqual(goodUiSpec());
    expect(drawn).toHaveLength(2);
  });

  it("draws nothing when no UI Spec passed validation", async () => {
    const broken = goodUiSpec();
    broken.screens[0]!.sliceTitle = "Nope";
    const { canvas, drawn } = fakeCanvas();
    const { agent } = agentReplaying(
      [submit(broken), answer("gave up")],
      canvas,
    );

    const { spec, screens } = await agent.design(input);

    expect(spec).toBeNull();
    expect(screens).toEqual([]);
    expect(drawn).toEqual([]);
  });

  it("checks the Penpot plugin before spending a Step", async () => {
    const { canvas } = fakeCanvas({
      checkConnection: async () => {
        throw new PenpotError("disconnected", "No Penpot plugin is connected.");
      },
    });
    const { agent, requests } = agentReplaying([submit(goodUiSpec())], canvas);

    await expect(agent.design(input)).rejects.toBeInstanceOf(PenpotError);
    expect(requests).toEqual([]);
  });

  it("surfaces a suspended tab from drawing, for the Orchestrator to escalate", async () => {
    const { canvas } = fakeCanvas({
      drawScreen: async () => {
        throw new PenpotError("suspended", "Focus the Penpot tab and retry.");
      },
    });
    const { agent } = agentReplaying([submit(goodUiSpec()), answer()], canvas);

    await expect(agent.design(input)).rejects.toMatchObject({
      kind: "suspended",
    });
  });

  it("revises with the Design Gate comments and the previous UI Spec", async () => {
    const { canvas } = fakeCanvas();
    const { agent, requests } = agentReplaying(
      [submit(goodUiSpec()), answer()],
      canvas,
    );

    await agent.design({
      ...input,
      revision: { previous: goodUiSpec(), comments: ["Add an empty state"] },
    });

    const user = requests[0]?.messages[1]?.content ?? "";
    expect(user).toMatch(/Comments:\n- Add an empty state/);
    expect(user).toContain('"name":"Todo list"');
  });

  it("design works when passed as a callback", async () => {
    const { canvas } = fakeCanvas();
    const { agent } = agentReplaying([submit(goodUiSpec()), answer()], canvas);
    const { design: designScreens } = agent;

    await expect(designScreens(input)).resolves.toMatchObject({
      screens: [{ name: "Health" }, { name: "Todo list" }],
    });
  });
});
