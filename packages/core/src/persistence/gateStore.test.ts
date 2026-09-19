import { describe, expect, it } from "vitest";
import { SqliteGateStore, type GateStore } from "./gateStore.js";
import { databaseWithRun } from "./testDatabase.js";

// Tests depend on the interface; only this factory knows the class.
function setup(): { store: GateStore; runId: string } {
  const { runId, options } = databaseWithRun();
  return { store: new SqliteGateStore(options), runId };
}

describe("SqliteGateStore", () => {
  it("opens a Gate, records per-document Verdicts and passes it", () => {
    const { store, runId } = setup();

    const gate = store.openGate(runId, "design");
    store.recordVerdict(gate.id, {
      documentKind: "apiContract",
      decision: "requestChanges",
      comments: "Add pagination to GET /todos",
    });
    store.recordVerdict(gate.id, {
      documentKind: "uiSpec",
      decision: "approve",
      comments: "",
    });
    const passed = store.passGate(gate.id);

    expect(gate).toMatchObject({ runId, kind: "design", status: "open" });
    expect(passed.status).toBe("passed");
    expect(store.getOpenGate(runId)).toBeNull();
    expect(
      store
        .listVerdicts(gate.id)
        .map((v) => [v.documentKind, v.decision, v.comments]),
    ).toEqual([
      ["apiContract", "requestChanges", "Add pagination to GET /todos"],
      ["uiSpec", "approve", ""],
    ]);
  });

  it("allows a PR Gate Verdict on the pull request as a whole", () => {
    const { store, runId } = setup();
    const gate = store.openGate(runId, "pr");

    const verdict = store.recordVerdict(gate.id, {
      documentKind: null,
      decision: "approve",
      comments: "LGTM",
    });

    expect(verdict.documentKind).toBeNull();
  });

  it("allows only one open Gate per Run", () => {
    const { store, runId } = setup();
    store.openGate(runId, "design");

    expect(() => store.openGate(runId, "pr")).toThrow(
      /already has an open design Gate/,
    );
  });

  it("refuses Verdicts and passing once a Gate is passed", () => {
    const { store, runId } = setup();
    const gate = store.openGate(runId, "design");
    store.passGate(gate.id);

    expect(() =>
      store.recordVerdict(gate.id, {
        documentKind: null,
        decision: "approve",
        comments: "",
      }),
    ).toThrow(/already passed/);
    expect(() => store.passGate(gate.id)).toThrow(/already passed/);
    expect(store.openGate(runId, "pr").kind).toBe("pr");
  });

  it("throws NotFoundError for an unknown Gate", () => {
    const { store } = setup();

    expect(() => store.passGate("nope")).toThrow(/Gate nope not found/);
  });
});
