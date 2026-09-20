import { describe, expect, it } from "vitest";
import { SqliteDocumentStore } from "./documentStore.js";
import { SqliteGateStore, type GateStore } from "./gateStore.js";
import { SqliteRunStore } from "./runStore.js";
import { databaseWithRun } from "./testDatabase.js";

// Tests depend on the interface; only this factory knows the class.
function setup() {
  const { runId, options } = databaseWithRun();
  const documents = new SqliteDocumentStore(options);
  const store: GateStore = new SqliteGateStore(options);
  const newDocument = (kind: "apiContract" | "uiSpec", run = runId) =>
    documents.createDocument({ runId: run, kind, content: kind });
  const otherRunId = new SqliteRunStore(options).createRun({
    projectRequest: "other",
    mode: "auto",
    targetRepo: { owner: "o", name: "r", baseBranch: "main", runBranch: "b" },
    stackProfile: "react-express",
    tokenBudget: 1,
  }).id;
  return { store, runId, otherRunId, documents, newDocument };
}

describe("SqliteGateStore", () => {
  it("opens a Gate, records Verdicts on document versions and passes it", () => {
    const { store, runId, newDocument } = setup();
    const contract = newDocument("apiContract");
    const uiSpec = newDocument("uiSpec");

    const gate = store.openGate(runId, "design");
    store.recordVerdict(gate.id, {
      documentId: contract.id,
      decision: "requestChanges",
      comments: "Add pagination to GET /todos",
    });
    store.recordVerdict(gate.id, {
      documentId: uiSpec.id,
      decision: "approve",
      comments: "",
    });
    const passed = store.closeGate(gate.id, "passed");

    expect(gate).toMatchObject({ runId, kind: "design", status: "open" });
    expect(passed.status).toBe("passed");
    expect(store.getOpenGate(runId)).toBeNull();
    expect(
      store
        .listVerdicts(gate.id)
        .map((v) => [v.document, v.decision, v.comments]),
    ).toEqual([
      [
        { id: contract.id, kind: "apiContract", version: 1 },
        "requestChanges",
        "Add pagination to GET /todos",
      ],
      [{ id: uiSpec.id, kind: "uiSpec", version: 1 }, "approve", ""],
    ]);
  });

  it("keeps pointing at the judged version after the document is revised", () => {
    const { store, runId, documents, newDocument } = setup();
    const v1 = newDocument("apiContract");
    documents.applyEvent(runId, "apiContract", "ownerFinished");
    const gate = store.openGate(runId, "design");
    store.recordVerdict(gate.id, {
      documentId: v1.id,
      decision: "requestChanges",
      comments: "fix",
    });

    documents.applyEvent(runId, "apiContract", "changesRequested");
    documents.applyEvent(runId, "apiContract", "ownerRevises");

    expect(store.listVerdicts(gate.id)[0]?.document?.version).toBe(1);
  });

  it("allows a PR Gate Verdict on the pull request as a whole", () => {
    const { store, runId } = setup();
    const gate = store.openGate(runId, "pr");

    const verdict = store.recordVerdict(gate.id, {
      documentId: null,
      decision: "approve",
      comments: "LGTM",
    });

    expect(verdict.document).toBeNull();
  });

  it("rejects a Verdict on another Run's document or an unknown one", () => {
    const { store, runId, otherRunId, newDocument } = setup();
    const foreign = newDocument("uiSpec", otherRunId);
    const gate = store.openGate(runId, "design");

    expect(() =>
      store.recordVerdict(gate.id, {
        documentId: foreign.id,
        decision: "approve",
        comments: "",
      }),
    ).toThrow(/belongs to another Run/);
    expect(() =>
      store.recordVerdict(gate.id, {
        documentId: "nope",
        decision: "approve",
        comments: "",
      }),
    ).toThrow(/Document nope not found/);
    expect(store.listVerdicts(gate.id)).toEqual([]);
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
    store.closeGate(gate.id, "passed");

    expect(() =>
      store.recordVerdict(gate.id, {
        documentId: null,
        decision: "approve",
        comments: "",
      }),
    ).toThrow("is already decided (passed)");
    expect(() => store.closeGate(gate.id, "passed")).toThrow(/already decided/);
    expect(store.openGate(runId, "pr").kind).toBe("pr");
  });

  it("throws NotFoundError for an unknown Gate", () => {
    const { store } = setup();

    expect(() => store.closeGate("nope", "passed")).toThrow(
      /Gate nope not found/,
    );
  });
});
