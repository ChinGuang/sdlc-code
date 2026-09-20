import { describe, expect, it } from "vitest";
import {
  DOCUMENT_KINDS,
  type DocumentKind,
} from "../domain/documentLifecycle.js";
import type { RunMode } from "../domain/runLifecycle.js";
import { SqliteDocumentStore } from "../persistence/documentStore.js";
import { SqliteGateStore } from "../persistence/gateStore.js";
import { SqliteRunStore } from "../persistence/runStore.js";
import { openDatabase } from "../persistence/database.js";
import { DocumentDesignGate, type DesignGate } from "./designGate.js";

function setup(mode: RunMode = "gated") {
  const db = openDatabase(":memory:");
  let id = 0;
  let tick = 0;
  const options = {
    db,
    newId: () => `id-${++id}`,
    now: () => new Date(Date.UTC(2026, 8, 28, 0, 0, tick++)).toISOString(),
  };
  const runs = new SqliteRunStore(options);
  const documents = new SqliteDocumentStore(options);
  const gates = new SqliteGateStore(options);
  const { id: runId } = runs.createRun({
    projectRequest: "Build a todo app",
    mode,
    targetRepo: {
      owner: "o",
      name: "r",
      baseBranch: "main",
      runBranch: "sdlc/x",
    },
    stackProfile: "react-express",
    tokenBudget: 1_000_000,
  });
  for (const kind of DOCUMENT_KINDS)
    documents.createDocument({ runId, kind, content: `${kind} v1` });
  // Tests depend on the interface; only this factory knows the class.
  const gate: DesignGate = new DocumentDesignGate({
    db,
    runs,
    documents,
    gates,
  });
  return { gate, runs, documents, gates, runId };
}

const statuses = (
  documents: ReturnType<typeof setup>["documents"],
  runId: string,
) =>
  Object.fromEntries(
    documents
      .listLatest(runId)
      .map((document) => [document.kind, document.status]),
  ) as Record<DocumentKind, string>;

const approveAll = (kinds: readonly DocumentKind[] = DOCUMENT_KINDS) =>
  kinds.map((documentKind) => ({
    documentKind,
    decision: "approve" as const,
    comments: "",
  }));

describe("DocumentDesignGate.open", () => {
  it("puts every document in review and opens the Design Gate (gated)", () => {
    const { gate, runs, gates, documents, runId } = setup();

    const result = gate.open(runId);

    expect(result).toMatchObject({ mode: "gated", gateId: "id-7" });
    expect(runs.getRun(runId)?.status).toBe("awaitingDesignGate");
    expect(gates.getOpenGate(runId)).toMatchObject({ kind: "design" });
    expect(Object.values(statuses(documents, runId))).toEqual(
      Array(5).fill("inReview"),
    );
  });

  it("approves the documents and starts building, with no Gate (auto)", () => {
    const { gate, runs, gates, documents, runId } = setup("auto");

    const result = gate.open(runId);

    expect(result).toEqual({ mode: "auto", gateId: null });
    expect(runs.getRun(runId)?.status).toBe("building");
    expect(gates.getOpenGate(runId)).toBeNull();
    expect(Object.values(statuses(documents, runId))).toEqual(
      Array(5).fill("approved"),
    );
  });
});

describe("DocumentDesignGate.decide", () => {
  it("approves every document, passes the Gate and starts building", () => {
    const { gate, runs, gates, documents, runId } = setup();
    const { gateId } = gate.open(runId);

    const outcome = gate.decide(runId, approveAll());

    expect(outcome).toEqual({
      outcome: "approved",
      revisions: [],
      staleDocuments: [],
    });
    expect(runs.getRun(runId)?.status).toBe("building");
    expect(gates.getOpenGate(runId)).toBeNull();
    expect(gates.listVerdicts(gateId!)).toHaveLength(5);
    expect(Object.values(statuses(documents, runId))).toEqual(
      Array(5).fill("approved"),
    );
  });

  it("routes each comment to the document's owning agent", () => {
    const { gate, runId } = setup();
    gate.open(runId);

    const outcome = gate.decide(runId, [
      ...approveAll(["systemDesign", "slicePlan", "penpotDesign"]),
      {
        documentKind: "apiContract",
        decision: "requestChanges",
        comments: "Add pagination to GET /todos",
      },
      {
        documentKind: "uiSpec",
        decision: "requestChanges",
        comments: "Add an empty state",
      },
    ]);

    expect(outcome.outcome).toBe("changesRequested");
    expect(outcome.revisions).toEqual([
      {
        agentRole: "systemDesign",
        documentKind: "apiContract",
        comments: "Add pagination to GET /todos",
      },
      {
        agentRole: "uiDesign",
        documentKind: "uiSpec",
        comments: "Add an empty state",
      },
      // The contract changed, so the Penpot design must be redone as well.
      { agentRole: "uiDesign", documentKind: "penpotDesign", comments: "" },
    ]);
  });

  it("marks the UI documents Stale when a System Design document changes (diagram 4)", () => {
    const { gate, runs, documents, runId } = setup();
    gate.open(runId);

    const outcome = gate.decide(runId, [
      ...approveAll(["systemDesign", "apiContract", "uiSpec", "penpotDesign"]),
      {
        documentKind: "slicePlan",
        decision: "requestChanges",
        comments: "Split the Todos Slice",
      },
    ]);

    expect(outcome.staleDocuments).toEqual(["uiSpec", "penpotDesign"]);
    expect(statuses(documents, runId)).toMatchObject({
      slicePlan: "changesRequested",
      uiSpec: "stale",
      penpotDesign: "stale",
    });
    expect(runs.getRun(runId)?.status).toBe("designing");
    // The UI agent redoes the stale documents, even though nobody commented.
    expect(outcome.revisions.map((revision) => revision.documentKind)).toEqual([
      "slicePlan",
      "uiSpec",
      "penpotDesign",
    ]);
  });

  it("does not make anything Stale when only UI documents need changes", () => {
    const { gate, documents, runId } = setup();
    gate.open(runId);

    const outcome = gate.decide(runId, [
      ...approveAll([
        "systemDesign",
        "slicePlan",
        "apiContract",
        "penpotDesign",
      ]),
      {
        documentKind: "uiSpec",
        decision: "requestChanges",
        comments: "Bigger tap targets",
      },
    ]);

    expect(outcome.staleDocuments).toEqual([]);
    expect(statuses(documents, runId)).toMatchObject({
      systemDesign: "approved",
      uiSpec: "changesRequested",
      penpotDesign: "approved",
    });
  });

  it("re-opens a Gate after the revisions, and can then approve", () => {
    const { gate, runs, gates, documents, runId } = setup();
    gate.open(runId);
    gate.decide(runId, [
      ...approveAll([
        "systemDesign",
        "slicePlan",
        "apiContract",
        "penpotDesign",
      ]),
      { documentKind: "uiSpec", decision: "requestChanges", comments: "again" },
    ]);

    // The UI Design Agent revises it, which starts a new version.
    documents.applyEvent(runId, "uiSpec", "ownerRevises");

    const reopened = gate.open(runId);
    // Only the document that was sent back is judged again.
    const outcome = gate.decide(runId, approveAll(["uiSpec"]));

    expect(reopened.gateId).not.toBeNull();
    expect(gates.getOpenGate(runId)).toBeNull();
    expect(outcome.outcome).toBe("approved");
    expect(runs.getRun(runId)?.status).toBe("building");
  });

  it("refuses to re-open the Gate while a document still awaits its revision", () => {
    const { gate, runId } = setup();
    gate.open(runId);
    gate.decide(runId, [
      ...approveAll([
        "systemDesign",
        "slicePlan",
        "apiContract",
        "penpotDesign",
      ]),
      { documentKind: "uiSpec", decision: "requestChanges", comments: "x" },
    ]);

    expect(() => gate.open(runId)).toThrow(/uiSpec still awaits its revision/);
  });

  it("refuses a verdict for a document that was not judged, or judged twice", () => {
    const { gate, runId } = setup();
    gate.open(runId);

    expect(() => gate.decide(runId, approveAll(["systemDesign"]))).toThrow(
      /needs a Verdict: slicePlan, apiContract, uiSpec, penpotDesign/,
    );
    expect(() =>
      gate.decide(runId, [...approveAll(), ...approveAll(["uiSpec"])]),
    ).toThrow(/judged twice: uiSpec/);
    gate.decide(runId, approveAll());
    expect(() => gate.decide(runId, approveAll())).toThrow(
      /has no open Design Gate/,
    );
  });

  it("refuses to decide when no Design Gate is open", () => {
    const { gate, runId } = setup();

    expect(() => gate.decide(runId, approveAll())).toThrow(
      /has no open Design Gate/,
    );
  });
});

describe("DocumentDesignGate.documentChanged", () => {
  it("re-opens the Design Gate when an Approved Document changes (CONTEXT.md)", () => {
    const { gate, runs, documents, runId } = setup();
    gate.open(runId);
    gate.decide(runId, approveAll());

    const outcome = gate.documentChanged(runId, "apiContract");

    expect(outcome).toEqual({
      staleDocuments: ["uiSpec", "penpotDesign"],
      revisions: [
        { agentRole: "uiDesign", documentKind: "uiSpec", comments: "" },
        { agentRole: "uiDesign", documentKind: "penpotDesign", comments: "" },
      ],
    });
    expect(runs.getRun(runId)?.status).toBe("designing");
    expect(statuses(documents, runId)).toMatchObject({
      apiContract: "drafting",
      uiSpec: "stale",
      penpotDesign: "stale",
    });
  });

  it("keeps the new version of the changed document", () => {
    const { gate, documents, runId } = setup();
    gate.open(runId);
    gate.decide(runId, approveAll());

    gate.documentChanged(runId, "systemDesign");

    expect(
      documents
        .listVersions(runId, "systemDesign")
        .map((d) => [d.version, d.status]),
    ).toEqual([
      [1, "approved"],
      [2, "drafting"],
    ]);
  });
});
