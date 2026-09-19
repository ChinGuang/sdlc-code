import { describe, expect, it } from "vitest";
import { goodDesign } from "./fixtures/goodDesign.js";
import { mermaidProblem } from "./mermaid.js";
import { contractEndpoints, validateDesign } from "./validateDesign.js";

describe("mermaidProblem", () => {
  it.each([
    "flowchart TD\n  A --> B",
    "classDiagram\n  class A {\n    +id\n  }\n  A <|-- B",
    "sequenceDiagram\n  A->>B: hi",
    "erDiagram\n  A ||--o{ B : has",
    "stateDiagram-v2\n  [*] --> A",
  ])("accepts %j", async (source) => {
    expect(await mermaidProblem(source)).toBeNull();
  });

  it.each([
    "flowchart TD\n  A -->",
    "classDiagram\n  class A {{{",
    "not a diagram",
  ])("reports %j", async (source) => {
    expect(await mermaidProblem(source)).toEqual(expect.any(String));
  });

  it("leaves no global window behind", async () => {
    await mermaidProblem("flowchart TD\n  A --> B");

    expect("window" in globalThis).toBe(false);
    expect("document" in globalThis).toBe(false);
  });
});

describe("validateDesign", () => {
  it("accepts a good design", async () => {
    expect(await validateDesign(goodDesign())).toEqual([]);
  });

  it("reports an invalid Mermaid diagram by title", async () => {
    const design = goodDesign();
    design.systemDesign.diagrams[1]!.mermaid = "classDiagram\n  class Todo {{{";

    expect(await validateDesign(design)).toEqual([
      expect.stringMatching(/^Diagram "Domain" is not valid Mermaid/),
    ]);
  });

  it("asks for Mermaid without code fences", async () => {
    const design = goodDesign();
    design.systemDesign.diagrams[0]!.mermaid =
      "```mermaid\nflowchart TD\n  A --> B\n```";

    expect(await validateDesign(design)).toEqual([
      expect.stringMatching(/without ``` fences/),
    ]);
  });

  it("reports an API Contract that is not OpenAPI 3", async () => {
    const design = goodDesign();
    design.apiContract.openapi = "2.0";

    expect(await validateDesign(design)).toContain(
      'API Contract: "openapi" must be "3.1.0" (OpenAPI 3.x).',
    );
  });

  it("reports OpenAPI schema errors with their location", async () => {
    const design = goodDesign();
    design.apiContract.info = { title: "Todo API" };

    expect(await validateDesign(design)).toEqual([
      expect.stringMatching(/not valid OpenAPI at "\/info".*version/),
    ]);
  });

  it("requires Slice 1 to be the Walking Skeleton, and only Slice 1", async () => {
    const design = goodDesign();
    design.slicePlan.reverse();

    expect(await validateDesign(design)).toEqual(
      expect.arrayContaining([
        "Slice 1 must be the Walking Skeleton (isWalkingSkeleton: true).",
        'Slice 2 "Walking Skeleton": only Slice 1 is the Walking Skeleton.',
      ]),
    );
  });

  it("keeps feature endpoints out of the Walking Skeleton (spike T03 finding)", async () => {
    const design = goodDesign();
    design.slicePlan[0]!.endpoints.push("GET /todos");
    design.slicePlan[1]!.endpoints.shift();

    expect(await validateDesign(design)).toEqual([
      expect.stringMatching(
        /Walking Skeleton is infrastructure only.*move GET \/todos/,
      ),
    ]);
  });

  it("requires GET /health in the Walking Skeleton", async () => {
    const design = goodDesign();
    design.slicePlan[0]!.endpoints = [];

    expect(await validateDesign(design)).toEqual(
      expect.arrayContaining([
        'The Walking Skeleton must include "GET /health".',
        'Slice 1 "Walking Skeleton" has no API Contract endpoints.',
        "API Contract operation GET /health is not in any Slice.",
      ]),
    );
  });

  it("requires every Slice endpoint to exist in the API Contract", async () => {
    const design = goodDesign();
    design.slicePlan[1]!.endpoints.push("DELETE /todos/{id}");

    expect(await validateDesign(design)).toEqual([
      'Slice "Todos" lists DELETE /todos/{id}, which is not in the API Contract.',
    ]);
  });

  it("requires every contract operation to belong to exactly one Slice", async () => {
    const design = goodDesign();
    design.slicePlan.push({
      title: "Editing",
      goal: "Rename todos",
      isWalkingSkeleton: false,
      endpoints: ["PATCH /todos/{id}"],
    });

    expect(await validateDesign(design)).toEqual([
      "PATCH /todos/{id} is in more than one Slice (Todos, Editing); give it to exactly one.",
    ]);
  });

  it("rejects duplicate Slice titles", async () => {
    const design = goodDesign();
    design.slicePlan[1]!.title = "Walking Skeleton";

    expect(await validateDesign(design)).toContain(
      'Slice 2: the title "Walking Skeleton" is used twice.',
    );
  });
});

describe("contractEndpoints", () => {
  it("lists every operation as METHOD /path", () => {
    expect(contractEndpoints(goodDesign().apiContract)).toEqual([
      "GET /health",
      "GET /todos",
      "POST /todos",
      "PATCH /todos/{id}",
    ]);
  });
});
