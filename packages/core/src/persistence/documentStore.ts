import { documentOwner, type AgentRole } from "../agentRoles.js";
import {
  documentsMadeStale,
  nextDocumentStatus,
  type DocumentEvent,
  type DocumentKind,
  type DocumentStatus,
} from "../domain/documentLifecycle.js";
import type { RunDocument } from "../domain/entities.js";
import { inTransaction } from "./database.js";
import {
  NotFoundError,
  storeContext,
  type StoreContext,
  type StoreOptions,
} from "./storeOptions.js";

/**
 * A Run's documents, versioned. Every return to "drafting" (a revision) starts a
 * new version; earlier versions are kept for review history.
 */
export interface DocumentStore {
  /** Version 1, drafting, owned by the document's agent (documentOwner). */
  createDocument: (document: NewDocument) => RunDocument;
  /** Replaces the content of the latest version; only while it is drafting. */
  saveContent: (
    runId: string,
    kind: DocumentKind,
    content: string,
  ) => RunDocument;
  /** Moves the latest version through UML diagram 4. */
  applyEvent: (
    runId: string,
    kind: DocumentKind,
    event: DocumentEvent,
  ) => RunDocument;
  /** Marks downstream documents Stale after `changed` changed; returns their kinds. */
  markUpstreamChanged: (runId: string, changed: DocumentKind) => DocumentKind[];
  getLatest: (runId: string, kind: DocumentKind) => RunDocument | null;
  /** The latest version of each document the Run has. */
  listLatest: (runId: string) => RunDocument[];
  listVersions: (runId: string, kind: DocumentKind) => RunDocument[];
}

export type NewDocument = {
  runId: string;
  kind: DocumentKind;
  content: string;
};

type DocumentRow = {
  id: string;
  run_id: string;
  kind: DocumentKind;
  version: number;
  status: DocumentStatus;
  owner_agent: AgentRole;
  content: string;
  created_at: string;
};

export class SqliteDocumentStore implements DocumentStore {
  #ctx: StoreContext;

  constructor(options: StoreOptions) {
    this.#ctx = storeContext(options);
  }

  createDocument = ({ runId, kind, content }: NewDocument): RunDocument =>
    inTransaction(this.#ctx.db, () => {
      if (this.getLatest(runId, kind))
        throw new Error(`Run ${runId} already has a ${kind} document`);
      this.#insert({
        runId,
        kind,
        version: 1,
        ownerAgent: documentOwner(kind),
        content,
      });
      return this.#requireLatest(runId, kind);
    });

  saveContent = (
    runId: string,
    kind: DocumentKind,
    content: string,
  ): RunDocument =>
    inTransaction(this.#ctx.db, () => {
      const latest = this.#requireLatest(runId, kind);
      if (latest.status !== "drafting")
        throw new Error(
          `${kind} v${latest.version} is ${latest.status}; only a drafting version can be edited`,
        );
      this.#ctx.db
        .prepare("UPDATE documents SET content = ? WHERE id = ?")
        .run(content, latest.id);
      return this.#requireLatest(runId, kind);
    });

  applyEvent = (
    runId: string,
    kind: DocumentKind,
    event: DocumentEvent,
  ): RunDocument =>
    inTransaction(this.#ctx.db, () => {
      this.#apply(this.#requireLatest(runId, kind), event);
      return this.#requireLatest(runId, kind);
    });

  markUpstreamChanged = (
    runId: string,
    changed: DocumentKind,
  ): DocumentKind[] =>
    inTransaction(this.#ctx.db, () => {
      const statuses = Object.fromEntries(
        this.listLatest(runId).map((doc) => [doc.kind, doc.status]),
      );
      const stale = documentsMadeStale(changed, statuses);
      for (const kind of stale)
        this.#apply(this.#requireLatest(runId, kind), "upstreamChanged");
      return stale;
    });

  getLatest = (runId: string, kind: DocumentKind): RunDocument | null => {
    const row = this.#ctx.db
      .prepare(
        "SELECT * FROM documents WHERE run_id = ? AND kind = ? ORDER BY version DESC LIMIT 1",
      )
      .get(runId, kind);
    return row ? toDocument(row as DocumentRow) : null;
  };

  listLatest = (runId: string): RunDocument[] =>
    this.#ctx.db
      .prepare(
        `SELECT d.* FROM documents d
         WHERE d.run_id = ? AND d.version =
           (SELECT MAX(version) FROM documents WHERE run_id = d.run_id AND kind = d.kind)
         ORDER BY d.created_at, d.kind`,
      )
      .all(runId)
      .map((row) => toDocument(row as DocumentRow));

  listVersions = (runId: string, kind: DocumentKind): RunDocument[] =>
    this.#ctx.db
      .prepare(
        "SELECT * FROM documents WHERE run_id = ? AND kind = ? ORDER BY version",
      )
      .all(runId, kind)
      .map((row) => toDocument(row as DocumentRow));

  #apply(latest: RunDocument, event: DocumentEvent): void {
    const status = nextDocumentStatus(latest.status, event);
    if (status === "drafting") {
      this.#insert({ ...latest, version: latest.version + 1 });
    } else {
      this.#ctx.db
        .prepare("UPDATE documents SET status = ? WHERE id = ?")
        .run(status, latest.id);
    }
  }

  #insert(doc: {
    runId: string;
    kind: DocumentKind;
    version: number;
    ownerAgent: AgentRole;
    content: string;
  }): void {
    this.#ctx.db
      .prepare(
        `INSERT INTO documents (id, run_id, kind, version, status, owner_agent, content, created_at)
         VALUES (?, ?, ?, ?, 'drafting', ?, ?, ?)`,
      )
      .run(
        this.#ctx.newId(),
        doc.runId,
        doc.kind,
        doc.version,
        doc.ownerAgent,
        doc.content,
        this.#ctx.now(),
      );
  }

  #requireLatest(runId: string, kind: DocumentKind): RunDocument {
    const latest = this.getLatest(runId, kind);
    if (!latest) throw new NotFoundError(`${kind} document of Run`, runId);
    return latest;
  }
}

function toDocument(row: DocumentRow): RunDocument {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    version: row.version,
    status: row.status,
    ownerAgent: row.owner_agent,
    content: row.content,
    createdAt: row.created_at,
  };
}
