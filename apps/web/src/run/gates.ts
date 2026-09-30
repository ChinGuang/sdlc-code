/**
 * What the decision screens show and check, worked out without rendering: the
 * Design Gate's Verdicts and its Stale warning, the PR Gate's Findings, and
 * how an Escalation is named. The server checks every decision again.
 */
import type {
  DesignVerdict,
  DocumentKind,
  DocumentStatus,
  Finding,
  RunDetail,
  RunDocument,
  RunSlice,
  Severity,
} from "../api/types.js";
import type { Badge } from "./view.js";

export const DOCUMENT_NAMES: Record<DocumentKind, string> = {
  systemDesign: "System Design",
  slicePlan: "Slice Plan",
  apiContract: "API Contract",
  uiSpec: "UI Spec",
  penpotDesign: "Penpot design",
};

export function documentBadge(status: DocumentStatus): Badge {
  switch (status) {
    case "drafting":
      return { label: "Drafting", tone: "muted" };
    case "inReview":
      return { label: "In review", tone: "blue" };
    case "approved":
      return { label: "Approved", tone: "green" };
    case "changesRequested":
      return { label: "Changes requested", tone: "red" };
    case "stale":
      return { label: "Stale", tone: "amber" };
  }
}

/** A Verdict being written: comments are kept while the decision changes. */
export type DraftVerdict = {
  decision: DesignVerdict["decision"] | null;
  comments: string;
};

export type Draft = Partial<Record<DocumentKind, DraftVerdict>>;

/** The documents a person must judge now: every one in review. */
export function awaiting(run: Pick<RunDetail, "waiting">): DocumentKind[] {
  return run.waiting.for === "designGate"
    ? run.waiting.documents.map((document) => document.kind)
    : [];
}

/**
 * Why the Verdicts cannot be sent yet: the Gate needs one on every document
 * in review, and a change nobody explains is no use to the agent who makes it.
 */
export function verdictProblems(
  kinds: readonly DocumentKind[],
  draft: Draft,
): string[] {
  return kinds.flatMap((kind) => {
    const verdict = draft[kind];
    if (!verdict?.decision) return [`${DOCUMENT_NAMES[kind]} needs a Verdict.`];
    if (verdict.decision === "requestChanges" && !verdict.comments.trim())
      return [`Say what should change in the ${DOCUMENT_NAMES[kind]}.`];
    return [];
  });
}

export function verdictsFrom(
  kinds: readonly DocumentKind[],
  draft: Draft,
): DesignVerdict[] {
  return kinds.map((kind) => ({
    documentKind: kind,
    decision: draft[kind]!.decision!,
    comments: draft[kind]!.comments.trim(),
  }));
}

/**
 * The documents the requested changes would make Stale: each is redone after
 * the one it builds on, and judged again.
 */
export function goingStale(
  documents: RunDocument[],
  draft: Draft,
): DocumentKind[] {
  const stale = new Set<DocumentKind>();
  for (const document of documents)
    if (draft[document.kind]?.decision === "requestChanges")
      for (const kind of document.wouldMakeStale) stale.add(kind);
  // A document whose own changes are requested is redone anyway.
  return [...stale].filter(
    (kind) => draft[kind]?.decision !== "requestChanges",
  );
}

/** "2 approved · 1 changes requested · 2 stale", as the Gate's header says it. */
export function tally(documents: RunDocument[], draft: Draft): string {
  const decided = (decision: DesignVerdict["decision"]) =>
    documents.filter(
      (document) =>
        draft[document.kind]?.decision === decision ||
        (decision === "approve" &&
          !draft[document.kind] &&
          document.status === "approved"),
    ).length;
  const stale = new Set([
    ...documents
      .filter((document) => document.status === "stale")
      .map((document) => document.kind),
    ...goingStale(documents, draft),
  ]);
  return [
    `${decided("approve")} approved`,
    `${decided("requestChanges")} changes requested`,
    `${stale.size} stale`,
  ].join(" · ");
}

/** "UI Spec and Penpot design": names read as a sentence. */
export function names(kinds: readonly DocumentKind[]): string {
  const spelled = kinds.map((kind) => DOCUMENT_NAMES[kind]);
  return spelled.length <= 1
    ? (spelled[0] ?? "")
    : `${spelled.slice(0, -1).join(", ")} and ${spelled.at(-1)!}`;
}

export const SEVERITIES: readonly Severity[] = ["blocking", "major", "minor"];

export function severityTone(severity: Severity): Badge["tone"] {
  return severity === "blocking"
    ? "red"
    : severity === "major"
      ? "amber"
      : "muted";
}

export function countBySeverity(
  findings: readonly Finding[],
): Record<Severity, number> {
  const counts = { blocking: 0, major: 0, minor: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** "src/web/notes.ts:42", or the file alone for a Finding about all of it. */
export const locationOf = (finding: Finding) =>
  finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;

const TRIGGER_TITLES: Record<string, string> = {
  loop: "Loop detected",
  retryBudget: "Retry Budget spent",
  tokenBudget: "Token Budget spent",
  undecidableOwner: "No owner for an Issue",
};

const TRIGGER_WHY: Record<string, string> = {
  loop: "The same failure came back after a fix, so the Orchestrator stopped early instead of using the remaining retries.",
  retryBudget: "The Slice used every retry and still fails its Test Run.",
  tokenBudget:
    "The Run has spent its Token Budget, so nothing more runs until you decide.",
  undecidableOwner:
    "The Orchestrator could not tell which agent an Issue belongs to.",
};

/** "Loop detected in Slice 3", and why it stopped, in words. */
export function escalationTitle(
  trigger: string,
  slice: string | null,
  slices: RunSlice[],
): { title: string; why: string } {
  const index = slices.findIndex((one) => one.title === slice);
  const where =
    index >= 0 ? ` in Slice ${index + 1}` : slice ? ` in ${slice}` : "";
  return {
    title: `${TRIGGER_TITLES[trigger] ?? "Escalated"}${where}`,
    why: TRIGGER_WHY[trigger] ?? "",
  };
}
