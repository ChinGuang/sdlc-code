import type { Escalation, EscalationBrief } from "../domain/entities.js";
import type {
  EscalationChoice,
  EscalationTrigger,
} from "../domain/runLifecycle.js";
import { inTransaction } from "./database.js";
import {
  fromFlag,
  NotFoundError,
  storeContext,
  toFlag,
  type StoreContext,
  type StoreOptions,
} from "./storeOptions.js";

export type EscalationDecision = {
  choice: EscalationChoice;
  /** The human's hint for "retry with hint". */
  hint?: string;
  /** For "abort": open a Draft PR with the passed Slices. Default true. */
  openDraftPrOnAbort?: boolean;
};

export type NewEscalation = {
  trigger: EscalationTrigger;
  summary: string;
  /** The Slice being built, by title, as a Run's failure names it. */
  slice?: string | null;
  /** The Issue Reports that led here, so a person sees what kept failing. */
  reports?: readonly unknown[];
};

/** Escalations and how humans resolved them. */
export interface EscalationStore {
  /** Opens an Escalation; a Run has at most one unresolved Escalation. */
  openEscalation: (runId: string, escalation: NewEscalation) => Escalation;
  getOpenEscalation: (runId: string) => Escalation | null;
  resolveEscalation: (id: string, decision: EscalationDecision) => Escalation;
  /** Keeps its brief (T24c), written after it opened; a later one replaces it. */
  setBrief: (id: string, brief: EscalationBrief) => Escalation;
  listEscalations: (runId: string) => Escalation[];
}

type EscalationRow = {
  id: string;
  run_id: string;
  trigger: EscalationTrigger;
  summary: string;
  choice: EscalationChoice | null;
  hint: string | null;
  open_draft_pr_on_abort: number;
  slice: string | null;
  reports: string;
  brief: string | null;
  created_at: string;
  resolved_at: string | null;
};

export class SqliteEscalationStore implements EscalationStore {
  #ctx: StoreContext;

  constructor(options: StoreOptions) {
    this.#ctx = storeContext(options);
  }

  openEscalation = (
    runId: string,
    { trigger, summary, slice = null, reports = [] }: NewEscalation,
  ): Escalation =>
    inTransaction(this.#ctx.db, () => {
      if (this.getOpenEscalation(runId))
        throw new Error(`Run ${runId} already has an unresolved Escalation`);
      const id = this.#ctx.newId();
      this.#ctx.db
        .prepare(
          "INSERT INTO escalations (id, run_id, trigger, summary, slice, reports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          runId,
          trigger,
          summary,
          slice,
          JSON.stringify(reports),
          this.#ctx.now(),
        );
      return this.#require(id);
    });

  getOpenEscalation = (runId: string): Escalation | null => {
    const row = this.#ctx.db
      .prepare(
        "SELECT * FROM escalations WHERE run_id = ? AND resolved_at IS NULL",
      )
      .get(runId);
    return row ? toEscalation(row as EscalationRow) : null;
  };

  resolveEscalation = (id: string, decision: EscalationDecision): Escalation =>
    inTransaction(this.#ctx.db, () => {
      if (this.#require(id).resolvedAt !== null)
        throw new Error(`Escalation ${id} is already resolved`);
      this.#ctx.db
        .prepare(
          "UPDATE escalations SET choice = ?, hint = ?, open_draft_pr_on_abort = ?, resolved_at = ? WHERE id = ?",
        )
        .run(
          decision.choice,
          decision.hint ?? null,
          toFlag(decision.openDraftPrOnAbort ?? true),
          this.#ctx.now(),
          id,
        );
      return this.#require(id);
    });

  setBrief = (id: string, brief: EscalationBrief): Escalation => {
    this.#require(id);
    this.#ctx.db
      .prepare("UPDATE escalations SET brief = ? WHERE id = ?")
      .run(JSON.stringify(brief), id);
    return this.#require(id);
  };

  listEscalations = (runId: string): Escalation[] =>
    this.#ctx.db
      .prepare("SELECT * FROM escalations WHERE run_id = ? ORDER BY rowid")
      .all(runId)
      .map((row) => toEscalation(row as EscalationRow));

  #require(id: string): Escalation {
    const row = this.#ctx.db
      .prepare("SELECT * FROM escalations WHERE id = ?")
      .get(id);
    if (!row) throw new NotFoundError("Escalation", id);
    return toEscalation(row as EscalationRow);
  }
}

function toEscalation(row: EscalationRow): Escalation {
  return {
    id: row.id,
    runId: row.run_id,
    trigger: row.trigger,
    summary: row.summary,
    choice: row.choice,
    hint: row.hint,
    openDraftPrOnAbort: fromFlag(row.open_draft_pr_on_abort),
    slice: row.slice,
    reports: JSON.parse(row.reports) as unknown[],
    brief: row.brief ? (JSON.parse(row.brief) as EscalationBrief) : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}
