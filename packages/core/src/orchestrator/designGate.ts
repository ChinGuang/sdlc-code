/**
 * The Design Gate (UML diagram 5): the human's Verdict on each design document.
 * Approving all of them starts the build; any changes requested send comments
 * to the owning agent, make the UI documents Stale when a System Design
 * document changed, and the Gate re-opens after the revisions. A Run in auto
 * mode has no Gate at all.
 */
import { documentOwner, type AgentRole } from "../agentRoles.js";
import {
  DOCUMENT_KINDS,
  type DocumentKind,
} from "../domain/documentLifecycle.js";
import { inTransaction, type Database } from "../persistence/database.js";
import type { DocumentStore } from "../persistence/documentStore.js";
import type { GateStore } from "../persistence/gateStore.js";
import { NotFoundError } from "../persistence/storeOptions.js";
import type { RunStore } from "../persistence/runStore.js";
import type { Run } from "../domain/entities.js";

export type DesignVerdict = {
  documentKind: DocumentKind;
  decision: "approve" | "requestChanges";
  comments: string;
};

/** A document an agent must revise, with the comments that asked for it. */
export type Revision = {
  agentRole: AgentRole;
  documentKind: DocumentKind;
  comments: string;
};

export type GateOpened = {
  mode: "gated" | "auto";
  /** The open Gate, or null in auto mode. */
  gateId: string | null;
};

export type GateDecision = {
  outcome: "approved" | "changesRequested";
  revisions: Revision[];
  /** Documents made Stale by a change upstream of them. */
  staleDocuments: DocumentKind[];
};

export type DocumentChanged = {
  revisions: Revision[];
  staleDocuments: DocumentKind[];
};

export interface DesignGate {
  /** Both design agents have finished: open the Gate, or accept in auto mode. */
  open: (runId: string) => GateOpened;
  /** Records the Verdicts and works out what happens next. */
  decide: (runId: string, verdicts: DesignVerdict[]) => GateDecision;
  /** An Approved Document changed later, so the Design Gate must re-open. */
  documentChanged: (runId: string, kind: DocumentKind) => DocumentChanged;
}

export type DesignGateOptions = {
  /** The database the stores use; a Gate action is one transaction. */
  db: Database;
  runs: RunStore;
  documents: DocumentStore;
  gates: GateStore;
};

export class DocumentDesignGate implements DesignGate {
  #db: Database;
  #runs: RunStore;
  #documents: DocumentStore;
  #gates: GateStore;

  constructor(options: DesignGateOptions) {
    this.#db = options.db;
    this.#runs = options.runs;
    this.#documents = options.documents;
    this.#gates = options.gates;
  }

  open = (runId: string): GateOpened =>
    this.#inRun(runId, (run) => {
      const unrevised = this.#documents
        .listLatest(runId)
        .filter((document) => document.status === "changesRequested")
        .map((document) => document.kind);
      if (unrevised.length > 0)
        throw new Error(
          `Run ${runId} cannot open the Design Gate: ${unrevised.join(", ")} still awaits its revision.`,
        );
      for (const kind of DOCUMENT_KINDS) this.#finishDraft(runId, kind);
      if (run.mode === "auto") {
        // No human: the documents are accepted as they are (diagram 5).
        for (const kind of this.#awaitingVerdict(runId))
          this.#documents.applyEvent(runId, kind, "approved");
        this.#runs.applyEvent(runId, { type: "documentsReady" });
        return { mode: "auto", gateId: null };
      }
      this.#runs.applyEvent(runId, { type: "documentsReady" });
      return {
        mode: "gated",
        gateId: this.#gates.openGate(runId, "design").id,
      };
    });

  decide = (runId: string, verdicts: DesignVerdict[]): GateDecision =>
    this.#inRun(runId, () => {
      const gate = this.#gates.getOpenGate(runId);
      if (!gate || gate.kind !== "design")
        throw new Error(`Run ${runId} has no open Design Gate.`);
      assertOneVerdictPerDocument(verdicts, this.#awaitingVerdict(runId));

      for (const verdict of verdicts) {
        const document = this.#documents.getLatest(runId, verdict.documentKind);
        if (!document)
          throw new NotFoundError(
            `${verdict.documentKind} document of Run`,
            runId,
          );
        this.#gates.recordVerdict(gate.id, {
          documentId: document.id,
          decision: verdict.decision,
          comments: verdict.comments,
        });
        this.#documents.applyEvent(
          runId,
          verdict.documentKind,
          verdict.decision === "approve" ? "approved" : "changesRequested",
        );
      }
      this.#gates.passGate(gate.id);

      const changed = verdicts.filter(
        (verdict) => verdict.decision === "requestChanges",
      );
      if (changed.length === 0) {
        this.#runs.applyEvent(runId, { type: "designApproved" });
        return { outcome: "approved", revisions: [], staleDocuments: [] };
      }

      const stale = changed.flatMap((verdict) =>
        this.#documents.markUpstreamChanged(runId, verdict.documentKind),
      );
      this.#runs.applyEvent(runId, { type: "designChangesRequested" });
      return {
        outcome: "changesRequested",
        revisions: [
          ...changed.map((verdict) =>
            revisionFor(verdict.documentKind, verdict.comments),
          ),
          ...stale.map((kind) => revisionFor(kind, "")),
        ],
        staleDocuments: stale,
      };
    });

  documentChanged = (runId: string, kind: DocumentKind): DocumentChanged =>
    this.#inRun(runId, () => {
      // A new version of an Approved Document: it goes back to drafting…
      this.#documents.applyEvent(runId, kind, "changedAfterApproval");
      // …and whatever was built on it is Stale (CONTEXT.md "Stale").
      const stale = this.#documents.markUpstreamChanged(runId, kind);
      this.#runs.applyEvent(runId, { type: "issueOwnedByDesignAgent" });
      return {
        staleDocuments: stale,
        revisions: stale.map((staleKind) => revisionFor(staleKind, "")),
      };
    });

  /** The documents a human still has to judge: everything now in review. */
  #awaitingVerdict(runId: string): DocumentKind[] {
    return this.#documents
      .listLatest(runId)
      .filter((document) => document.status === "inReview")
      .map((document) => document.kind);
  }

  /** Moves a document the agent just wrote into review; leaves the rest alone. */
  #finishDraft(runId: string, kind: DocumentKind): void {
    const document = this.#documents.getLatest(runId, kind);
    if (!document) throw new NotFoundError(`${kind} document of Run`, runId);
    if (document.status === "drafting")
      this.#documents.applyEvent(runId, kind, "ownerFinished");
  }

  /** One transaction per Gate action: a rejected step must change nothing. */
  #inRun<T>(runId: string, work: (run: Run) => T): T {
    const run = this.#runs.getRun(runId);
    if (!run) throw new NotFoundError("Run", runId);
    return inTransaction(this.#db, () => work(run));
  }
}

function revisionFor(documentKind: DocumentKind, comments: string): Revision {
  return { agentRole: documentOwner(documentKind), documentKind, comments };
}

/**
 * A re-opened Gate only judges what changed: documents approved in an earlier
 * round keep their Verdict.
 */
function assertOneVerdictPerDocument(
  verdicts: DesignVerdict[],
  awaiting: DocumentKind[],
): void {
  const seen = new Set<DocumentKind>();
  const twice = new Set<DocumentKind>();
  for (const verdict of verdicts) {
    if (seen.has(verdict.documentKind)) twice.add(verdict.documentKind);
    seen.add(verdict.documentKind);
  }
  if (twice.size > 0)
    throw new Error(`Documents judged twice: ${[...twice].join(", ")}.`);
  const extra = [...seen].filter((kind) => !awaiting.includes(kind));
  if (extra.length > 0)
    throw new Error(
      `Not awaiting a Verdict: ${extra.join(", ")}; this Gate judges ${awaiting.join(", ")}.`,
    );
  const missing = awaiting.filter((kind) => !seen.has(kind));
  if (missing.length > 0)
    throw new Error(`Every document needs a Verdict: ${missing.join(", ")}.`);
}
