import { describe, expect, it } from "vitest";
import type { DocumentKind } from "../domain/documentLifecycle.js";
import { IllegalTransitionError } from "../domain/runLifecycle.js";
import { SqliteDocumentStore, type DocumentStore } from "./documentStore.js";
import { databaseWithRun } from "./testDatabase.js";

// Tests depend on the interface; only this factory knows the class.
function setup(): { store: DocumentStore; runId: string } {
  const { runId, options } = databaseWithRun();
  return { store: new SqliteDocumentStore(options), runId };
}

const create = (store: DocumentStore, runId: string, kind: DocumentKind) =>
  store.createDocument({
    runId,
    kind,
    content: `${kind} v1`,
  });

describe("SqliteDocumentStore", () => {
  it("creates version 1 in drafting and reads it back", () => {
    const { store, runId } = setup();

    const doc = create(store, runId, "apiContract");

    expect(doc).toMatchObject({
      runId,
      kind: "apiContract",
      version: 1,
      status: "drafting",
      ownerAgent: "systemDesign",
      content: "apiContract v1",
    });
    expect(store.getLatest(runId, "apiContract")).toEqual(doc);
    expect(store.getLatest(runId, "uiSpec")).toBeNull();
  });

  it("assigns each kind to its owning agent", () => {
    const { store, runId } = setup();

    expect(create(store, runId, "slicePlan").ownerAgent).toBe("systemDesign");
    expect(create(store, runId, "penpotDesign").ownerAgent).toBe("uiDesign");
  });

  it("refuses a second document of the same kind", () => {
    const { store, runId } = setup();
    create(store, runId, "slicePlan");

    expect(() => create(store, runId, "slicePlan")).toThrow(/already has/);
  });

  it("edits content only while drafting", () => {
    const { store, runId } = setup();
    create(store, runId, "systemDesign");

    expect(store.saveContent(runId, "systemDesign", "better").content).toBe(
      "better",
    );
    store.applyEvent(runId, "systemDesign", "ownerFinished");
    expect(() => store.saveContent(runId, "systemDesign", "sneaky")).toThrow(
      /only a drafting version/,
    );
  });

  it("keeps the reviewed version and starts a new one on revision", () => {
    const { store, runId } = setup();
    create(store, runId, "apiContract");
    store.applyEvent(runId, "apiContract", "ownerFinished");
    store.applyEvent(runId, "apiContract", "changesRequested");

    const revised = store.applyEvent(runId, "apiContract", "ownerRevises");

    expect(revised).toMatchObject({
      version: 2,
      status: "drafting",
      content: "apiContract v1",
    });
    expect(
      store
        .listVersions(runId, "apiContract")
        .map((d) => [d.version, d.status]),
    ).toEqual([
      [1, "changesRequested"],
      [2, "drafting"],
    ]);
  });

  it("rejects an illegal event and changes nothing", () => {
    const { store, runId } = setup();
    create(store, runId, "uiSpec");

    expect(() => store.applyEvent(runId, "uiSpec", "approved")).toThrow(
      IllegalTransitionError,
    );
    expect(store.listVersions(runId, "uiSpec")).toHaveLength(1);
    expect(store.getLatest(runId, "uiSpec")?.status).toBe("drafting");
  });

  it("marks the UI Design documents Stale when the API Contract changes", () => {
    const { store, runId } = setup();
    for (const kind of ["apiContract", "uiSpec", "penpotDesign"] as const) {
      create(store, runId, kind);
      store.applyEvent(runId, kind, "ownerFinished");
      store.applyEvent(runId, kind, "approved");
    }

    const stale = store.markUpstreamChanged(runId, "apiContract");

    expect(stale).toEqual(["uiSpec", "penpotDesign"]);
    expect(store.listLatest(runId).map((d) => [d.kind, d.status])).toEqual([
      ["apiContract", "approved"],
      ["uiSpec", "stale"],
      ["penpotDesign", "stale"],
    ]);
    expect(store.applyEvent(runId, "uiSpec", "redo")).toMatchObject({
      version: 2,
      status: "drafting",
    });
  });

  it("leaves documents that are still drafting alone", () => {
    const { store, runId } = setup();
    create(store, runId, "uiSpec");

    expect(store.markUpstreamChanged(runId, "systemDesign")).toEqual([]);
    expect(store.getLatest(runId, "uiSpec")?.status).toBe("drafting");
  });
});
