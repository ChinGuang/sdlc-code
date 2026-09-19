import type { DocumentKind } from "../domain/documentLifecycle.js";
import type { Gate, GateKind, Verdict } from "../domain/entities.js";
import { inTransaction } from "./database.js";
import {
  NotFoundError,
  storeContext,
  type StoreContext,
  type StoreOptions,
} from "./storeOptions.js";

export type NewVerdict = Pick<
  Verdict,
  "documentKind" | "decision" | "comments"
>;

/** Design and PR Gates and the Verdicts humans give at them. */
export interface GateStore {
  /** Opens a Gate; a Run has at most one open Gate. */
  openGate: (runId: string, kind: GateKind) => Gate;
  getOpenGate: (runId: string) => Gate | null;
  recordVerdict: (gateId: string, verdict: NewVerdict) => Verdict;
  listVerdicts: (gateId: string) => Verdict[];
  passGate: (gateId: string) => Gate;
}

type GateRow = {
  id: string;
  run_id: string;
  kind: GateKind;
  status: "open" | "passed";
  opened_at: string;
};

type VerdictRow = {
  id: string;
  gate_id: string;
  document_kind: DocumentKind | null;
  decision: Verdict["decision"];
  comments: string;
  created_at: string;
};

export class SqliteGateStore implements GateStore {
  #ctx: StoreContext;

  constructor(options: StoreOptions) {
    this.#ctx = storeContext(options);
  }

  openGate = (runId: string, kind: GateKind): Gate =>
    inTransaction(this.#ctx.db, () => {
      const open = this.getOpenGate(runId);
      if (open)
        throw new Error(`Run ${runId} already has an open ${open.kind} Gate`);
      const id = this.#ctx.newId();
      this.#ctx.db
        .prepare(
          "INSERT INTO gates (id, run_id, kind, status, opened_at) VALUES (?, ?, ?, 'open', ?)",
        )
        .run(id, runId, kind, this.#ctx.now());
      return this.#require(id);
    });

  getOpenGate = (runId: string): Gate | null => {
    const row = this.#ctx.db
      .prepare("SELECT * FROM gates WHERE run_id = ? AND status = 'open'")
      .get(runId);
    return row ? toGate(row as GateRow) : null;
  };

  recordVerdict = (gateId: string, verdict: NewVerdict): Verdict =>
    inTransaction(this.#ctx.db, () => {
      this.#requireOpen(gateId);
      const id = this.#ctx.newId();
      this.#ctx.db
        .prepare(
          `INSERT INTO verdicts (id, gate_id, document_kind, decision, comments, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          gateId,
          verdict.documentKind,
          verdict.decision,
          verdict.comments,
          this.#ctx.now(),
        );
      const row = this.#ctx.db
        .prepare("SELECT * FROM verdicts WHERE id = ?")
        .get(id) as VerdictRow;
      return toVerdict(row);
    });

  listVerdicts = (gateId: string): Verdict[] =>
    this.#ctx.db
      .prepare("SELECT * FROM verdicts WHERE gate_id = ? ORDER BY rowid")
      .all(gateId)
      .map((row) => toVerdict(row as VerdictRow));

  passGate = (gateId: string): Gate =>
    inTransaction(this.#ctx.db, () => {
      this.#requireOpen(gateId);
      this.#ctx.db
        .prepare("UPDATE gates SET status = 'passed' WHERE id = ?")
        .run(gateId);
      return this.#require(gateId);
    });

  #require(id: string): Gate {
    const row = this.#ctx.db
      .prepare("SELECT * FROM gates WHERE id = ?")
      .get(id);
    if (!row) throw new NotFoundError("Gate", id);
    return toGate(row as GateRow);
  }

  #requireOpen(id: string): Gate {
    const gate = this.#require(id);
    if (gate.status !== "open") throw new Error(`Gate ${id} is already passed`);
    return gate;
  }
}

function toGate(row: GateRow): Gate {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    openedAt: row.opened_at,
  };
}

function toVerdict(row: VerdictRow): Verdict {
  return {
    id: row.id,
    gateId: row.gate_id,
    documentKind: row.document_kind,
    decision: row.decision,
    comments: row.comments,
    createdAt: row.created_at,
  };
}
