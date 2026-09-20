import { describe, expect, it } from "vitest";
import { goodUiSpec, uiSpecContext } from "./fixtures/goodUiSpec.js";
import { uiSpecProblems } from "./validateUiSpec.js";

describe("uiSpecProblems", () => {
  it("accepts a UI Spec that matches the design", () => {
    expect(uiSpecProblems(goodUiSpec(), uiSpecContext())).toEqual([]);
  });

  it("requires every screen endpoint to exist in the API Contract", () => {
    const spec = goodUiSpec();
    spec.screens[1]!.endpoints.push("DELETE /todos/{id}");

    expect(uiSpecProblems(spec, uiSpecContext())).toEqual([
      'Screen "Todo list": DELETE /todos/{id} is not in the API Contract.',
    ]);
  });

  it("requires every feature endpoint to be called by some screen", () => {
    const spec = goodUiSpec();
    spec.screens[1]!.endpoints = ["GET /todos"];

    expect(uiSpecProblems(spec, uiSpecContext())).toEqual([
      "No screen calls POST /todos.",
      "No screen calls PATCH /todos/{id}.",
    ]);
  });

  it("does not ask for a screen that calls GET /health", () => {
    const spec = goodUiSpec();
    spec.screens[0]!.endpoints = [];

    expect(uiSpecProblems(spec, uiSpecContext())).toEqual([]);
  });

  it("requires each screen's Slice to exist, and each Slice to have a screen", () => {
    const spec = goodUiSpec();
    spec.screens[0]!.sliceTitle = "Onboarding";

    expect(uiSpecProblems(spec, uiSpecContext())).toEqual([
      'Screen "Health": sliceTitle "Onboarding" is not a Slice in the Slice Plan (Walking Skeleton, Todos).',
      'Slice "Walking Skeleton" has no screen.',
    ]);
  });

  it("rejects duplicate screen names and routes", () => {
    const spec = goodUiSpec();
    spec.screens[1]!.name = "Health";
    spec.screens[1]!.route = "/health";

    expect(uiSpecProblems(spec, uiSpecContext())).toEqual(
      expect.arrayContaining([
        'Screen "Health": two screens have this name.',
        'Screen "Health": route /health is used twice.',
      ]),
    );
  });

  it("keeps elements inside the board", () => {
    const spec = goodUiSpec();
    spec.screens[0]!.elements[0] = {
      kind: "heading",
      label: "Too wide",
      x: 1000,
      y: 700,
      width: 400,
      height: 200,
    };

    expect(uiSpecProblems(spec, uiSpecContext())).toEqual([
      'Screen "Health": "Too wide" runs past the right edge (x 1000 + width 400 > 1280).',
      'Screen "Health": "Too wide" runs past the bottom edge (y 700 + height 200 > 800).',
    ]);
  });
});
