import type { ChatRequest, ChatResponse, ToolCall } from "@sdlc-code/clients";
import { describe, expect, it } from "vitest";
import { ChatAgentLoop } from "../../agentLoop/agentLoop.js";
import { designDocuments } from "./designDocuments.js";
import { goodDesign } from "./fixtures/goodDesign.js";
import recorded from "./fixtures/recordedTodoRun.json" with { type: "json" };
import {
  NemotronSystemDesignAgent,
  SUBMIT_DESIGN,
  type SystemDesignAgent,
} from "./systemDesignAgent.js";

type Reply = { content: string | null; toolCalls: ToolCall[] };

/** An agent whose model replays `replies` in order; `requests` records what it was sent. */
function agentReplaying(replies: Reply[]) {
  const requests: ChatRequest[] = [];
  const queue = [...replies];
  // Tests depend on the interface; only this factory knows the class.
  const agent: SystemDesignAgent = new NemotronSystemDesignAgent({
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
              usage: { promptTokens: 1000, completionTokens: 200 },
              latencyMs: 1,
            };
          },
        },
        request: { model: "nvidia/Nemotron-3-Ultra-550b-a55b" },
        tools,
        maxIterations: 4,
      }),
  });
  return { agent, requests };
}

const submit = (design: unknown, id = "call-1"): Reply => ({
  content: null,
  toolCalls: [{ id, name: SUBMIT_DESIGN, arguments: JSON.stringify(design) }],
});
const input = {
  projectRequest: "Build a todo app.",
  stackProfile: "React + Vite; Node API with Prisma",
};

describe("NemotronSystemDesignAgent", () => {
  it("replays a recorded Nemotron Ultra run into a valid design", async () => {
    const { agent } = agentReplaying(recorded.replies as Reply[]);

    const { design, loop } = await agent.design({
      ...input,
      projectRequest: recorded.projectRequest,
    });

    expect(loop.stopReason).toBe("answered");
    expect(design?.slicePlan[0]).toMatchObject({
      isWalkingSkeleton: true,
      endpoints: ["GET /health"],
    });
    expect(design?.slicePlan.length).toBeGreaterThan(1);
    expect(design?.apiContract.openapi).toBe("3.1.0");
  });

  it("sends the role prompt, the request and the Stack Profile, with only the submit tool", async () => {
    const { agent, requests } = agentReplaying([
      submit(goodDesign()),
      { content: "A todo app.", toolCalls: [] },
    ]);

    await agent.design(input);

    expect(requests[0]?.messages[0]?.content).toMatch(/System Design Agent/);
    expect(requests[0]?.messages[1]?.content).toMatch(
      /Project Request:\nBuild a todo app\.[\s\S]*Stack Profile:\nReact \+ Vite/,
    );
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      SUBMIT_DESIGN,
    ]);
  });

  it("returns validation problems to the model, which fixes them in the same Step", async () => {
    const broken = goodDesign();
    broken.slicePlan.reverse();
    const { agent, requests } = agentReplaying([
      submit(broken, "first"),
      submit(goodDesign(), "second"),
      { content: "A todo app.", toolCalls: [] },
    ]);

    const { design, loop } = await agent.design(input);

    const rejection = requests[1]?.messages.at(-1);
    expect(rejection).toMatchObject({ role: "tool", tool_call_id: "first" });
    expect(rejection?.content).toMatch(
      /Design rejected[\s\S]*Slice 1 must be the Walking Skeleton/,
    );
    expect(loop).toMatchObject({ stopReason: "answered", failedToolCalls: 1 });
    expect(design).toEqual(goodDesign());
  });

  it("returns no design when nothing passed validation", async () => {
    const broken = goodDesign();
    broken.apiContract.openapi = "2.0";
    const { agent } = agentReplaying([
      submit(broken),
      { content: "I give up.", toolCalls: [] },
    ]);

    const { design, loop } = await agent.design(input);

    expect(design).toBeNull();
    expect(loop.stopReason).toBe("answered");
  });

  it("revises with the Design Gate comments and the previous design", async () => {
    const { agent, requests } = agentReplaying([
      submit(goodDesign()),
      { content: "Revised.", toolCalls: [] },
    ]);

    await agent.design({
      ...input,
      revision: {
        previous: goodDesign(),
        comments: ["Add due dates to todos"],
      },
    });

    const user = requests[0]?.messages[1]?.content ?? "";
    expect(user).toMatch(/Reviewer comments:\n- Add due dates to todos/);
    expect(user).toContain('"title":"Walking Skeleton"');
  });

  it("design works when passed as a callback", async () => {
    const { agent } = agentReplaying([
      submit(goodDesign()),
      { content: "ok", toolCalls: [] },
    ]);
    const { design } = agent;

    await expect(design(input)).resolves.toMatchObject({
      design: goodDesign(),
    });
  });
});

describe("designDocuments", () => {
  it("renders Markdown with Mermaid blocks, and JSON for the Slice Plan and API Contract", () => {
    const docs = designDocuments(goodDesign());

    expect(docs.systemDesign).toMatch(
      /^# System Design\n\nA React \+ Vite frontend/,
    );
    expect(docs.systemDesign).toContain(
      "## Domain\n\n```mermaid\nclassDiagram\n  class Todo {",
    );
    expect(JSON.parse(docs.slicePlan)).toEqual(goodDesign().slicePlan);
    expect(JSON.parse(docs.apiContract)).toEqual(goodDesign().apiContract);
  });

  it("keeps the model's own title instead of adding a second one", () => {
    const design = goodDesign();
    design.systemDesign.overview = "# Todo App\n\nDetails.";

    expect(designDocuments(design).systemDesign).toMatch(
      /^# Todo App\n\nDetails\./,
    );
  });
});
