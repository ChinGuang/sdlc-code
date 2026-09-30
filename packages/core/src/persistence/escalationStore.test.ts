import { describe, expect, it } from "vitest";
import {
  SqliteEscalationStore,
  type EscalationStore,
} from "./escalationStore.js";
import { databaseWithRun } from "./testDatabase.js";

// Tests depend on the interface; only this factory knows the class.
function setup(): { store: EscalationStore; runId: string } {
  const { runId, options } = databaseWithRun();
  return { store: new SqliteEscalationStore(options), runId };
}

describe("SqliteEscalationStore", () => {
  it("opens an Escalation with the Draft PR checkbox ticked by default", () => {
    const { store, runId } = setup();

    const escalation = store.openEscalation(runId, {
      trigger: "retryBudget",
      summary: "POST /todos still returns 500 after 3 retries",
    });

    expect(escalation).toMatchObject({
      runId,
      trigger: "retryBudget",
      summary: "POST /todos still returns 500 after 3 retries",
      choice: null,
      hint: null,
      openDraftPrOnAbort: true,
      resolvedAt: null,
    });
    expect(store.getOpenEscalation(runId)).toEqual(escalation);
  });

  it("has no Slice and no Issue Reports unless it is given them", () => {
    const { store, runId } = setup();

    expect(
      store.openEscalation(runId, { trigger: "tokenBudget", summary: "spent" }),
    ).toMatchObject({ slice: null, reports: [] });
  });

  it("keeps the Slice it stopped in and the Issue Reports behind it", () => {
    const { store, runId } = setup();
    const report = { step: "smoke", error: "POST /todos: 500", evidence: "…" };

    store.openEscalation(runId, {
      trigger: "loop",
      summary: "same error twice",
      slice: "Todos",
      reports: [report],
    });

    expect(store.getOpenEscalation(runId)).toMatchObject({
      slice: "Todos",
      reports: [report],
    });
  });

  it("resolves with a hint", () => {
    const { store, runId } = setup();
    const { id } = store.openEscalation(runId, {
      trigger: "loop",
      summary: "same error",
    });

    const resolved = store.resolveEscalation(id, {
      choice: "retryWithHint",
      hint: "Validate title before insert",
    });

    expect(resolved).toMatchObject({
      choice: "retryWithHint",
      hint: "Validate title before insert",
    });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(store.getOpenEscalation(runId)).toBeNull();
  });

  it("remembers an unticked Draft PR checkbox on abort", () => {
    const { store, runId } = setup();
    const { id } = store.openEscalation(runId, {
      trigger: "tokenBudget",
      summary: "s",
    });

    expect(
      store.resolveEscalation(id, {
        choice: "abort",
        openDraftPrOnAbort: false,
      }).openDraftPrOnAbort,
    ).toBe(false);
  });

  it("allows one unresolved Escalation per Run, and resolving only once", () => {
    const { store, runId } = setup();
    const { id } = store.openEscalation(runId, {
      trigger: "loop",
      summary: "a",
    });

    expect(() =>
      store.openEscalation(runId, { trigger: "loop", summary: "b" }),
    ).toThrow(/unresolved Escalation/);
    store.resolveEscalation(id, { choice: "skipSlice" });
    expect(() => store.resolveEscalation(id, { choice: "abort" })).toThrow(
      /already resolved/,
    );
    store.openEscalation(runId, { trigger: "undecidableOwner", summary: "c" });
    expect(store.listEscalations(runId).map((e) => e.summary)).toEqual([
      "a",
      "c",
    ]);
  });
});
