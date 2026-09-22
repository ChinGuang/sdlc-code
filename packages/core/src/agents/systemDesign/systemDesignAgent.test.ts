import type { ChatRequest, ChatResponse, ToolCall } from "@sdlc-code/clients";
import { beforeAll, describe, expect, it } from "vitest";
import { stringify as toYaml } from "yaml";
import { ChatAgentLoop } from "../../agentLoop/agentLoop.js";
import type { Design } from "./design.js";
import { designDocuments } from "./designDocuments.js";
import { goodDesign } from "./fixtures/goodDesign.js";
import { MERMAID_LOAD_TIMEOUT, warmMermaid } from "./fixtures/warmMermaid.js";
import recorded from "./fixtures/recordedTodoRun.json" with { type: "json" };
import {
  DESIGN_TOOLS,
  LoopSystemDesignAgent,
  type SystemDesignAgent,
} from "./systemDesignAgent.js";

beforeAll(warmMermaid, MERMAID_LOAD_TIMEOUT);

type Reply = { content: string | null; toolCalls: ToolCall[] };

/** An agent whose model replays `replies` in order; `requests` records what it was sent. */
function agentReplaying(replies: Reply[], maxIterations = 8) {
  const requests: ChatRequest[] = [];
  const queue = [...replies];
  // Tests depend on the interface; only this factory knows the class.
  const agent: SystemDesignAgent = new LoopSystemDesignAgent({
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
        maxIterations,
      }),
  });
  return { agent, requests };
}

let callId = 0;
const call = (name: string, args: unknown): Reply => ({
  content: null,
  toolCalls: [
    { id: `call-${++callId}`, name, arguments: JSON.stringify(args) },
  ],
});
const submitSystemDesign = (design: Design) =>
  call(DESIGN_TOOLS.systemDesign, design.systemDesign);
const submitSlicePlan = (design: Design) =>
  call(DESIGN_TOOLS.slicePlan, { slices: design.slicePlan });
const submitApiContract = (design: Design) =>
  call(DESIGN_TOOLS.apiContract, { openapi: toYaml(design.apiContract) });
const finish = () => call(DESIGN_TOOLS.finish, {});
const answer = (content = "A todo app."): Reply => ({ content, toolCalls: [] });

/** The happy path: every part, finish, then the one-sentence answer. */
const submitAll = (design: Design): Reply[] => [
  submitSystemDesign(design),
  submitSlicePlan(design),
  submitApiContract(design),
  finish(),
  answer(),
];

const input = {
  projectRequest: "Build a todo app.",
  stackProfile: "React + Vite; Node API with Prisma",
};
const lastToolMessage = (request: ChatRequest | undefined) =>
  request?.messages.at(-1)?.content ?? "";

describe("LoopSystemDesignAgent", () => {
  it("replays a recorded Nemotron Ultra run into a valid design", async () => {
    const { agent } = agentReplaying(recorded.replies as Reply[], 12);

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

  it("accepts a design submitted part by part", async () => {
    const { agent, requests } = agentReplaying(submitAll(goodDesign()));

    const { design, loop } = await agent.design(input);

    expect(design).toEqual(goodDesign());
    expect(loop).toMatchObject({ stopReason: "answered", failedToolCalls: 0 });
    expect(lastToolMessage(requests[4])).toMatch(/^Design accepted/);
  });

  it("sends the role prompt, the request and the Stack Profile, with the four design tools", async () => {
    const { agent, requests } = agentReplaying(submitAll(goodDesign()));

    await agent.design(input);

    expect(requests[0]?.messages[0]?.content).toMatch(/System Design Agent/);
    expect(requests[0]?.messages[1]?.content).toMatch(
      /Project Request:\nBuild a todo app\.[\s\S]*Stack Profile:\nReact \+ Vite/,
    );
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(
      Object.values(DESIGN_TOOLS),
    );
  });

  it("accepts the API Contract as JSON text too", async () => {
    const design = goodDesign();
    const { agent } = agentReplaying([
      submitSystemDesign(design),
      submitSlicePlan(design),
      call(DESIGN_TOOLS.apiContract, {
        openapi: JSON.stringify(design.apiContract),
      }),
      finish(),
      answer(),
    ]);

    expect((await agent.design(input)).design).toEqual(design);
  });

  it("rejects a bad part with its problems, and the model resubmits only that part", async () => {
    const broken = goodDesign();
    broken.slicePlan.reverse();
    const { agent, requests } = agentReplaying([
      submitSystemDesign(goodDesign()),
      submitSlicePlan(broken),
      submitSlicePlan(goodDesign()),
      submitApiContract(goodDesign()),
      finish(),
      answer(),
    ]);

    const { design, loop } = await agent.design(input);

    expect(lastToolMessage(requests[2])).toMatch(
      /^Error: submit_slice_plan failed: Slice Plan rejected[\s\S]*Slice 1 must be the Walking Skeleton/,
    );
    expect(loop.failedToolCalls).toBe(1);
    expect(design).toEqual(goodDesign());
  });

  it("reports an API Contract that is not YAML or JSON", async () => {
    const { agent, requests } = agentReplaying([
      call(DESIGN_TOOLS.apiContract, { openapi: "openapi: [3.1.0" }),
      answer("stop"),
    ]);

    await agent.design(input);

    expect(lastToolMessage(requests[1])).toMatch(
      /API Contract rejected[\s\S]*not valid YAML or JSON/,
    );
  });

  it("will not finish before every part is saved", async () => {
    const { agent, requests } = agentReplaying([
      submitSystemDesign(goodDesign()),
      finish(),
      answer("stop"),
    ]);

    const { design } = await agent.design(input);

    expect(design).toBeNull();
    expect(lastToolMessage(requests[2])).toMatch(
      /Nothing valid saved yet from submit_slice_plan, submit_api_contract/,
    );
  });

  it("checks the Slice Plan against the API Contract when finishing", async () => {
    const withExtra = goodDesign();
    withExtra.slicePlan[1]!.endpoints.push("DELETE /todos/{id}");
    const { agent, requests } = agentReplaying([
      submitSystemDesign(withExtra),
      submitSlicePlan(withExtra),
      submitApiContract(withExtra),
      finish(),
      answer("stop"),
    ]);

    const { design } = await agent.design(input);

    expect(design).toBeNull();
    expect(lastToolMessage(requests[4])).toMatch(
      /Design rejected[\s\S]*DELETE \/todos\/\{id\}, which is not in the API Contract/,
    );
  });

  it("does not fall back to an older part after a rejected resubmission", async () => {
    const broken = goodDesign();
    broken.systemDesign.diagrams[0]!.mermaid = "flowchart TD\n  A -->";
    const { agent, requests } = agentReplaying([
      submitSystemDesign(goodDesign()),
      submitSlicePlan(goodDesign()),
      submitApiContract(goodDesign()),
      submitSystemDesign(broken),
      finish(),
      answer("stop"),
    ]);

    const { design } = await agent.design(input);

    expect(design).toBeNull();
    expect(lastToolMessage(requests[5])).toMatch(
      /Nothing valid saved yet from submit_system_design/,
    );
  });

  it("withdraws an acceptance when a part changes after finish_design", async () => {
    const { agent } = agentReplaying([
      ...submitAll(goodDesign()).slice(0, 4),
      submitSlicePlan(goodDesign()),
      answer("changed my mind"),
    ]);

    const { design } = await agent.design(input);

    expect(design).toBeNull();
  });

  it("revises with the Design Gate comments and the previous design", async () => {
    const { agent, requests } = agentReplaying(submitAll(goodDesign()));

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
    expect(user).toMatch(/Previous API Contract:\nopenapi: 3\.1\.0/);
  });

  it("design works when passed as a callback", async () => {
    const { agent } = agentReplaying(submitAll(goodDesign()));
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
