// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_VERSION,
  checkpointPayload,
  memoryFromCheckpoint,
  type RunMemoryState,
} from "./runCheckpoint.js";
import type { IssueReport } from "../agents/testing/issueReports.js";

const report = (overrides: Partial<IssueReport> = {}): IssueReport => ({
  step: "unit",
  failingTest: "POST /todos > rejects an empty title",
  file: "server/todos.test.ts",
  endpoint: "POST /todos",
  error: "expected 400, got 500",
  cause: null,
  evidence: "AssertionError: expected 400 got 500",
  suspectedOwner: "backendCoding",
  signature: "unit:POST /todos:400",
  occurrences: 1,
  ...overrides,
});

function memory(): RunMemoryState {
  return {
    revisions: [
      {
        agentRole: "systemDesign",
        documentKind: "apiContract",
        comments: "POST /todos needs a 400 response.",
      },
    ],
    histories: new Map([
      [
        "slice-2",
        {
          earlier: {
            backend: [report()],
            frontend: [],
            design: [report({ suspectedOwner: null, step: "smoke" })],
          },
          retryBaseline: { backend: 1 },
        },
      ],
    ]),
    hints: new Map([
      [
        "slice-2",
        {
          from: "codeReview" as const,
          issues: [
            {
              summary: "SEC-02 (blocking) in server/todos.ts: unvalidated body",
              evidence: "Validate the title before saving it.",
            },
          ],
        },
      ],
    ]),
    reviewRetries: 2,
  };
}

describe("checkpointPayload and memoryFromCheckpoint", () => {
  it("brings back the revisions, histories and hints a Run was carrying", () => {
    const back = memoryFromCheckpoint(checkpointPayload(memory()));

    expect(back).toEqual(memory());
  });

  it("survives being stored as JSON, which is how it is kept", () => {
    const stored = JSON.parse(JSON.stringify(checkpointPayload(memory())));

    expect(memoryFromCheckpoint(stored)).toEqual(memory());
  });

  it("copies what it saves, so later Steps cannot change a written Checkpoint", () => {
    const live = memory();
    const payload = checkpointPayload(live);

    live.hints.set("slice-2", {
      from: "person",
      issues: [{ summary: "changed after", evidence: "the Checkpoint" }],
    });
    live.revisions.push({
      agentRole: "uiDesign",
      documentKind: "uiSpec",
      comments: "later",
    });

    expect(Object.keys(payload.hints)).toEqual(["slice-2"]);
    expect(payload.hints["slice-2"]).toMatchObject({
      from: "codeReview",
      issues: [{ evidence: "Validate the title before saving it." }],
    });
    expect(payload.revisions).toHaveLength(1);
  });

  it("carries an empty memory as an empty Checkpoint", () => {
    const empty: RunMemoryState = {
      revisions: [],
      histories: new Map(),
      hints: new Map(),
      reviewRetries: 0,
    };

    expect(checkpointPayload(empty)).toEqual({
      version: CHECKPOINT_VERSION,
      revisions: [],
      histories: {},
      hints: {},
      reviewRetries: 0,
    });
    expect(memoryFromCheckpoint(checkpointPayload(empty))).toEqual(empty);
  });

  it("ignores a Checkpoint it cannot understand, rather than guessing", () => {
    for (const payload of [
      null,
      undefined,
      "a string",
      {},
      {
        version: CHECKPOINT_VERSION + 1,
        revisions: [],
        histories: {},
        hints: {},
      },
      { ...checkpointPayload(memory()), unexpected: true },
      { ...checkpointPayload(memory()), hints: { "slice-2": 7 } },
    ])
      expect(memoryFromCheckpoint(payload), JSON.stringify(payload)).toBeNull();
  });

  // T18 wrote hints as bare strings and had no review counter.
  it("reads a Checkpoint written before the review existed", () => {
    const old = {
      version: CHECKPOINT_VERSION,
      revisions: [],
      histories: {},
      hints: { "slice-2": "Validate the title before saving it." },
    };

    const back = memoryFromCheckpoint(old);

    expect(back?.reviewRetries).toBe(0);
    expect(back?.hints.get("slice-2")).toEqual({
      from: "person",
      issues: [
        {
          summary: "Validate the title before saving it.",
          evidence: "Validate the title before saving it.",
        },
      ],
    });
  });

  it("keeps an Issue Report whole, because it is what a retry is told", () => {
    const back = memoryFromCheckpoint(checkpointPayload(memory()))!;

    expect(back.histories.get("slice-2")!.earlier.backend[0]).toEqual(report());
  });

  // A restart goes on with the attempt under way, not a wider one.
  it("keeps who codes on the attempt under way, and a hint's sides (T24i)", () => {
    const state = memory();
    state.histories.get("slice-2")!.pending = {
      frontend: [{ summary: "Use getJson.", evidence: "Use getJson." }],
    };
    state.hints.set("slice-3", {
      from: "person",
      issues: [{ summary: "Return 404.", evidence: "Return 404." }],
      sides: ["backend"],
    });

    const back = memoryFromCheckpoint(
      JSON.parse(JSON.stringify(checkpointPayload(state))),
    )!;

    expect(back.histories.get("slice-2")!.pending).toEqual({
      frontend: [{ summary: "Use getJson.", evidence: "Use getJson." }],
    });
    expect(back.hints.get("slice-3")!.sides).toEqual(["backend"]);
  });

  it("reads an Issue Report written before it had a cause (T24c)", () => {
    const saved = JSON.parse(JSON.stringify(checkpointPayload(memory())));
    delete saved.histories["slice-2"].earlier.backend[0].cause;

    const back = memoryFromCheckpoint(saved)!;

    expect(back.histories.get("slice-2")!.earlier.backend[0]!.cause).toBeNull();
  });
});
