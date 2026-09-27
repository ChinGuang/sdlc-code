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
    hints: new Map([["slice-2", "Validate the title before saving it."]]),
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

    live.hints.set("slice-2", "changed after the Checkpoint");
    live.revisions.push({
      agentRole: "uiDesign",
      documentKind: "uiSpec",
      comments: "later",
    });

    expect(Object.keys(payload.hints)).toEqual(["slice-2"]);
    expect(payload.hints["slice-2"]).toBe(
      "Validate the title before saving it.",
    );
    expect(payload.revisions).toHaveLength(1);
  });

  it("carries an empty memory as an empty Checkpoint", () => {
    const empty: RunMemoryState = {
      revisions: [],
      histories: new Map(),
      hints: new Map(),
    };

    expect(checkpointPayload(empty)).toEqual({
      version: CHECKPOINT_VERSION,
      revisions: [],
      histories: {},
      hints: {},
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

  it("keeps an Issue Report whole, because it is what a retry is told", () => {
    const back = memoryFromCheckpoint(checkpointPayload(memory()))!;

    expect(back.histories.get("slice-2")!.earlier.backend[0]).toEqual(report());
  });
});
