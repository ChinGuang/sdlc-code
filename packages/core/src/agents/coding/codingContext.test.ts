import { REACT_NODE } from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import { goodDesign } from "../systemDesign/fixtures/goodDesign.js";
import { goodUiSpec } from "../uiDesign/fixtures/goodUiSpec.js";
import { codingContext, type CodingTaskInput } from "./codingContext.js";

const design = goodDesign();
const TODOS = design.slicePlan[1]!;
const png = (name: string) => ({
  bytes: Buffer.from(`png of ${name}`),
  mimeType: "image/png",
});

function input(overrides: Partial<CodingTaskInput> = {}): CodingTaskInput {
  return {
    side: "frontend",
    profile: REACT_NODE,
    projectRequest: "A todo app",
    slice: TODOS,
    documents: {
      systemDesign: "# System Design\n\nReact talks to a Node API.",
      slicePlan: design.slicePlan,
      apiContract: design.apiContract,
      uiSpec: goodUiSpec(),
    },
    issueReports: [],
    workingMemory: null,
    capabilities: { vision: false, penpotMcp: false },
    screenImages: new Map([
      ["Health", png("Health")],
      ["Todo list", png("Todo list")],
    ]),
    ...overrides,
  };
}

describe("codingContext per capability set", () => {
  it("text only: the UI Spec for this Slice, no images, no Penpot tools", () => {
    const context = codingContext(input());

    expect(context.task.user).toContain("UI Spec for this Slice:");
    expect(context.task.user).toContain("name: Todo list");
    expect(context.task.user).not.toContain("name: Health");
    expect(context.task.images).toBeUndefined();
    expect(context.usePenpotTools).toBe(false);
    expect(context.task.system).not.toContain("inspect_screen");
  });

  it("vision: this Slice's board PNGs are attached and named in order", () => {
    const context = codingContext(
      input({ capabilities: { vision: true, penpotMcp: false } }),
    );

    expect(context.task.images).toEqual([png("Todo list")]);
    expect(context.task.user).toContain(
      "Attached: the design of each screen, in this order: Todo list.",
    );
    expect(context.task.user).toContain("UI Spec for this Slice:");
    expect(context.usePenpotTools).toBe(false);
  });

  it("vision without exports: nothing to attach", () => {
    const context = codingContext(
      input({
        capabilities: { vision: true, penpotMcp: false },
        screenImages: new Map(),
      }),
    );

    expect(context.task.images).toBeUndefined();
    expect(context.task.user).not.toContain("Attached:");
  });

  it("penpotMcp: the live design tool for this Slice's screens", () => {
    const context = codingContext(
      input({ capabilities: { vision: false, penpotMcp: true } }),
    );

    expect(context.usePenpotTools).toBe(true);
    expect(context.screens).toEqual(["Todo list"]);
    expect(context.task.system).toContain("inspect_screen");
    expect(context.task.images).toBeUndefined();
  });

  it("vision and penpotMcp: both", () => {
    const context = codingContext(
      input({ capabilities: { vision: true, penpotMcp: true } }),
    );

    expect(context.task.images).toHaveLength(1);
    expect(context.usePenpotTools).toBe(true);
  });

  it("backend: no design material, whatever the model can see", () => {
    const context = codingContext(
      input({
        side: "backend",
        capabilities: { vision: true, penpotMcp: true },
      }),
    );

    expect(context.task.user).not.toContain("UI Spec");
    expect(context.task.images).toBeUndefined();
    expect(context.usePenpotTools).toBe(false);
    expect(context.task.system).toContain("Backend Coding Agent");
  });

  it("a Slice with no screens gives the frontend no Penpot tool", () => {
    const context = codingContext(
      input({
        slice: { ...TODOS, title: "Reports" },
        capabilities: { vision: true, penpotMcp: true },
      }),
    );

    expect(context.screens).toEqual([]);
    expect(context.usePenpotTools).toBe(false);
    expect(context.task.images).toBeUndefined();
  });
});

describe("codingContext inputs", () => {
  it("gives the Task and every Approved Document", () => {
    const { user } = codingContext(input({ side: "backend" })).task;

    expect(user).toContain('Your Task: build the backend of Slice "Todos".');
    expect(user).toContain(`Goal: ${TODOS.goal}`);
    expect(user).toContain(
      `Endpoints of this Slice: ${TODOS.endpoints.join(", ")}`,
    );
    expect(user).toContain("React talks to a Node API.");
    expect(user).toContain("API Contract (OpenAPI):\nopenapi: 3.1.0");
    expect(user).toContain("1. Walking Skeleton (built)");
    expect(user).toContain("2. Todos (this Task)");
  });

  it("puts Issue Reports first, with their evidence", () => {
    const { user } = codingContext(
      input({
        issueReports: [
          {
            summary: "POST /todos returns 500 for an empty title",
            evidence: "unit: Todos > rejects an empty title\nexpected 400",
          },
        ],
      }),
    ).task;

    expect(user).toContain(
      "Fix these problems first; the Slice was sent back because of them:\n1. POST /todos returns 500 for an empty title\n   Evidence: unit: Todos > rejects an empty title\n   expected 400",
    );
    expect(user.indexOf("Fix these problems")).toBeLessThan(
      user.indexOf("System Design:"),
    );
  });

  it("passes on the Working Memory of the previous attempt", () => {
    const { user } = codingContext(
      input({ workingMemory: "- validation is in server/todos.ts" }),
    ).task;

    expect(user).toContain(
      "Your notes from the previous attempt at this Task:\n- validation is in server/todos.ts",
    );
    expect(codingContext(input()).task.user).not.toContain("previous attempt");
  });

  it("tells the agent what it may write and the rules it is reviewed against", () => {
    const { system } = codingContext(input({ side: "backend" })).task;

    expect(system).toContain(
      "You may write only: server/, prisma/, package.json, .env.example.",
    );
    expect(system).toContain("SEC-01 (blocking):");
    expect(system).toContain("TEST-01 (blocking):");
    expect(system).toContain("React + Node");
  });
});
