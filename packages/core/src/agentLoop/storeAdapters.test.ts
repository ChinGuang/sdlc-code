import type { ChatRequest, ChatResponse } from "@sdlc-code/clients";
import { describe, expect, it } from "vitest";
import { SqliteRunStore } from "../persistence/runStore.js";
import { SqliteTaskStore } from "../persistence/taskStore.js";
import { databaseWithRun } from "../persistence/testDatabase.js";
import {
  ChatAgentLoop,
  type AgentLoop,
  type TokenBudget,
  type Transcript,
} from "./agentLoop.js";
import { RunTokenBudget, StepTranscript } from "./storeAdapters.js";

function setup() {
  const { runId, options } = databaseWithRun(); // tokenBudget 1000
  const runs = new SqliteRunStore(options);
  const tasks = new SqliteTaskStore(options);
  const task = tasks.createTask({
    runId,
    sliceId: null,
    agentRole: "systemDesign",
  });
  const step = tasks.startStep(task.id);
  // Tests depend on the interfaces; only this factory knows the classes.
  const transcript: Transcript = new StepTranscript(tasks, step.id);
  const budget: TokenBudget = new RunTokenBudget(runs, runId);
  return { runs, tasks, runId, stepId: step.id, transcript, budget };
}

const reply = (content: string, tokens: number): ChatResponse => ({
  content,
  reasoning: "thinking",
  toolCalls: [],
  finishReason: "stop",
  usage: { promptTokens: tokens, completionTokens: 0 },
  latencyMs: 1,
});

describe("StepTranscript", () => {
  it("stores each Transcript event as a Step event row", () => {
    const { tasks, stepId, transcript } = setup();

    transcript.record({ type: "message", role: "user", content: "hi" });
    transcript.record({ type: "usage", promptTokens: 5, completionTokens: 1 });

    expect(
      tasks.listStepEvents(stepId).map((e) => [e.seq, e.type, e.payload]),
    ).toEqual([
      [1, "message", { role: "user", content: "hi" }],
      [2, "usage", { promptTokens: 5, completionTokens: 1 }],
    ]);
  });
});

describe("RunTokenBudget", () => {
  it("reads what remains of the Run's budget and charges spending to it", () => {
    const { runs, runId, budget } = setup();

    budget.spend(300);

    expect(budget.remaining()).toBe(700);
    expect(runs.getRun(runId)?.tokensUsed).toBe(300);
  });
});

describe("ChatAgentLoop with the stores", () => {
  it("persists the Transcript and stops when the Run's budget is spent", async () => {
    const { runs, runId, tasks, stepId, transcript, budget } = setup();
    const requests: ChatRequest[] = [];
    const loop: AgentLoop = new ChatAgentLoop({
      client: {
        complete: async (request) => {
          requests.push(request);
          return reply("", 1200);
        },
      },
      request: { model: "m" },
      tools: [],
      maxIterations: 3,
      transcript,
      budget,
    });

    const result = await loop.run({ system: "s", user: "u" });

    expect(result.stopReason).toBe("emptyAnswer");
    expect(requests).toHaveLength(1);
    expect(runs.getRun(runId)?.tokensUsed).toBe(1200);
    expect(tasks.listStepEvents(stepId).map((e) => e.type)).toEqual([
      "message",
      "message",
      "assistant",
      "usage",
      "workingMemory",
    ]);
    expect(result.workingMemory).toMatch(/empty answer/);
  });
});
