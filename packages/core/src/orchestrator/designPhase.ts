/**
 * The Design Phase (UML diagram 5): the System Design Agent writes the System
 * Design, Slice Plan and API Contract, the UI Design Agent the UI Spec and the
 * Penpot design, each document is saved as a new version, and the Design Gate
 * opens (in auto mode, the documents are accepted as they are). A revision
 * redoes only the agents whose documents were sent back or went Stale.
 */
import type { ExportedImage } from "@sdlc-code/clients";
import type { StackProfile } from "@sdlc-code/stack-profiles";
import { designDocuments } from "../agents/systemDesign/designDocuments.js";
import type { SystemDesignAgent } from "../agents/systemDesign/systemDesignAgent.js";
import type { UiDesignAgent } from "../agents/uiDesign/uiDesignAgent.js";
import type { DocumentKind } from "../domain/documentLifecycle.js";
import type { Run } from "../domain/entities.js";
import type { DocumentStore } from "../persistence/documentStore.js";
import type { SliceStore } from "../persistence/sliceStore.js";
import { documentContent, storedDesign } from "./approvedDocuments.js";
import type { DesignGate, Revision } from "./designGate.js";

const SYSTEM_DESIGN_KINDS: readonly DocumentKind[] = [
  "systemDesign",
  "slicePlan",
  "apiContract",
];
const UI_DESIGN_KINDS: readonly DocumentKind[] = ["uiSpec", "penpotDesign"];

export type DesignPhaseResult = {
  /** The boards the UI Design Agent exported, by screen name (for `vision`). */
  screenImages: Map<string, ExportedImage>;
};

export interface DesignPhase {
  /**
   * Writes (or revises) the design documents and opens the Design Gate.
   * `revisions` names what was sent back; empty on the first Design Phase.
   */
  run: (run: Run, revisions: readonly Revision[]) => Promise<DesignPhaseResult>;
}

export class DesignPhaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignPhaseError";
  }
}

export type AgentDesignPhaseOptions = {
  documents: DocumentStore;
  slices: SliceStore;
  gate: DesignGate;
  systemDesign: SystemDesignAgent;
  uiDesign: UiDesignAgent;
  profile: (run: Run) => StackProfile;
  /** The Run's page in the Penpot Workspace File (runPageName). */
  pageName: (run: Run) => string;
};

export class AgentDesignPhase implements DesignPhase {
  #options: AgentDesignPhaseOptions;

  constructor(options: AgentDesignPhaseOptions) {
    this.#options = options;
  }

  run = async (
    run: Run,
    revisions: readonly Revision[],
  ): Promise<DesignPhaseResult> => {
    const { documents } = this.#options;
    const first = documents.getLatest(run.id, "systemDesign") === null;
    const comments = (kinds: readonly DocumentKind[]) =>
      revisions
        .filter((revision) => kinds.includes(revision.documentKind))
        .map((revision) => revision.comments.trim())
        .filter(Boolean);
    const needs = (kinds: readonly DocumentKind[]) =>
      first ||
      revisions.some((revision) => kinds.includes(revision.documentKind)) ||
      kinds.some((kind) => {
        const status = documents.getLatest(run.id, kind)?.status;
        // Drafting: sent back after approval, and not rewritten yet.
        return (
          status === "stale" ||
          status === "changesRequested" ||
          status === "drafting"
        );
      });

    if (needs(SYSTEM_DESIGN_KINDS)) {
      const { design, loop } = await this.#options.systemDesign.design({
        projectRequest: run.projectRequest,
        stackProfile: this.#options.profile(run).summary,
        revision: first
          ? undefined
          : {
              // The UI Spec is not needed here, and may not exist yet.
              previous: storedDesign({
                ...loadDesignForUi(documents, run.id),
                systemDesign: documentContent(
                  documents,
                  run.id,
                  "systemDesign",
                ),
              }),
              comments: comments(SYSTEM_DESIGN_KINDS),
            },
      });
      if (!design)
        throw new DesignPhaseError(
          `The System Design Agent produced no valid design: ${loop.workingMemory}`,
        );
      const written = designDocuments(design);
      for (const kind of SYSTEM_DESIGN_KINDS)
        this.#save(run.id, kind, written[kind as keyof typeof written]);
      this.#planSlices(run.id, design.slicePlan);
    }

    let screenImages = new Map<string, ExportedImage>();
    if (needs(UI_DESIGN_KINDS)) {
      const approved = loadDesignForUi(documents, run.id);
      const previousSpec = documents.getLatest(run.id, "uiSpec");
      const { spec, screens, page, loop } = await this.#options.uiDesign.design(
        {
          projectRequest: run.projectRequest,
          pageName: this.#options.pageName(run),
          slicePlan: approved.slicePlan,
          apiContract: approved.apiContract,
          revision: previousSpec
            ? {
                previous: JSON.parse(previousSpec.content),
                comments: comments(UI_DESIGN_KINDS),
              }
            : undefined,
        },
      );
      if (!spec || !page)
        throw new DesignPhaseError(
          `The UI Design Agent produced no valid UI Spec: ${loop.workingMemory}`,
        );
      this.#save(run.id, "uiSpec", `${JSON.stringify(spec, null, 2)}\n`);
      this.#save(
        run.id,
        "penpotDesign",
        `${JSON.stringify(
          {
            page,
            screens: screens.map(({ name, boardId }) => ({ name, boardId })),
          },
          null,
          2,
        )}\n`,
      );
      screenImages = new Map(
        screens.flatMap((screen) =>
          screen.export ? [[screen.name, screen.export] as const] : [],
        ),
      );
    }

    this.#options.gate.open(run.id);
    return { screenImages };
  };

  /**
   * Saves a document as its next version, moving it to drafting first. An
   * Approved Document that came out the same stays approved, so the Gate
   * does not ask about it again.
   */
  #save(runId: string, kind: DocumentKind, content: string): void {
    const { documents } = this.#options;
    const latest = documents.getLatest(runId, kind);
    if (!latest) {
      documents.createDocument({ runId, kind, content });
      return;
    }
    if (latest.status === "approved" && latest.content === content) return;
    const toDrafting = {
      drafting: null,
      inReview: null,
      approved: "changedAfterApproval",
      changesRequested: "ownerRevises",
      stale: "redo",
    } as const;
    const event = toDrafting[latest.status];
    if (event) documents.applyEvent(runId, kind, event);
    documents.saveContent(runId, kind, content);
  }

  /** The Slices to build; once building began, the ones not started follow the plan. */
  #planSlices(
    runId: string,
    plan: ReadonlyArray<{ title: string; isWalkingSkeleton: boolean }>,
  ): void {
    const { slices } = this.#options;
    const started = slices
      .listSlices(runId)
      .some((slice) => slice.status !== "pending");
    const planned = plan.map(({ title, isWalkingSkeleton }) => ({
      title,
      isWalkingSkeleton,
    }));
    if (started) slices.reconcileSlices(runId, planned);
    else slices.saveSlices(runId, planned);
  }
}

/** The Slice Plan and API Contract the UI Design Agent designs against. */
function loadDesignForUi(documents: DocumentStore, runId: string) {
  const content = (kind: DocumentKind) =>
    documentContent(documents, runId, kind);
  return {
    slicePlan: JSON.parse(content("slicePlan")),
    apiContract: JSON.parse(content("apiContract")),
  };
}
