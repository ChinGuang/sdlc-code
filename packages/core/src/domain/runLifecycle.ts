import { IllegalTransitionError } from "./illegalTransitionError.js";

/**
 * Run lifecycle (UML diagram 3) as a pure function. Slice-level progress inside
 * "building" (in progress → testing → committed) lives on each Slice's status.
 */

export const RUN_STATUSES = [
  "designing",
  "awaitingDesignGate",
  "building",
  "reviewing",
  "awaitingPrGate",
  "escalated",
  "done",
  "failed",
  "aborted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** gated: humans decide at the Design Gate, PR Gate and Escalations. auto: no humans. */
export type RunMode = "gated" | "auto";

export type EscalationTrigger =
  "retryBudget" | "tokenBudget" | "loop" | "undecidableOwner";
export type EscalationChoice =
  "retryWithHint" | "editDocuments" | "skipSlice" | "abort";

export type RunEvent =
  | { type: "documentsReady" }
  /** No valid design came out; with no one to ask (auto mode), the Run fails. */
  | { type: "designFailed" }
  | { type: "designChangesRequested" }
  | { type: "designApproved" }
  | { type: "issueOwnedByDesignAgent" }
  | { type: "allSlicesCommitted" }
  | { type: "blockingFindings" }
  | { type: "prOpened" }
  | { type: "prChangesRequested" }
  | { type: "prApproved" }
  | { type: "limitHit"; trigger: EscalationTrigger }
  | { type: "escalationResolved"; choice: EscalationChoice };

export const RUN_EVENT_TYPES = [
  "documentsReady",
  "designFailed",
  "designChangesRequested",
  "designApproved",
  "issueOwnedByDesignAgent",
  "allSlicesCommitted",
  "blockingFindings",
  "prOpened",
  "prChangesRequested",
  "prApproved",
  "limitHit",
  "escalationResolved",
] as const satisfies ReadonlyArray<RunEvent["type"]>;

/** Limits that can stop a review; loops and owner routing only happen while building. */
const REVIEW_LIMITS: ReadonlySet<EscalationTrigger> = new Set([
  "retryBudget",
  "tokenBudget",
]);

const ESCALATION_TARGET: Record<EscalationChoice, RunStatus> = {
  retryWithHint: "building",
  skipSlice: "building",
  editDocuments: "designing",
  abort: "aborted",
};

/** The status after `event`; throws IllegalTransitionError if diagram 3 has no such arrow. */
export function nextRunStatus(
  status: RunStatus,
  event: RunEvent,
  mode: RunMode,
): RunStatus {
  const gated = mode === "gated";
  const next = ((): RunStatus | null => {
    switch (status) {
      case "designing":
        if (event.type === "designFailed") return gated ? null : "failed";
        return event.type === "documentsReady"
          ? gated
            ? "awaitingDesignGate"
            : "building"
          : null;
      case "awaitingDesignGate":
        if (!gated) return null;
        if (event.type === "designChangesRequested") return "designing";
        if (event.type === "designApproved") return "building";
        return null;
      case "building":
        if (event.type === "issueOwnedByDesignAgent") return "designing";
        if (event.type === "allSlicesCommitted") return "reviewing";
        if (event.type === "limitHit") return gated ? "escalated" : "failed";
        return null;
      case "reviewing":
        if (event.type === "blockingFindings") return "building";
        if (event.type === "prOpened") return gated ? "awaitingPrGate" : "done";
        if (event.type === "limitHit" && REVIEW_LIMITS.has(event.trigger))
          return gated ? "escalated" : "failed";
        return null;
      case "awaitingPrGate":
        if (!gated) return null;
        if (event.type === "prChangesRequested") return "building";
        if (event.type === "prApproved") return "done";
        return null;
      case "escalated":
        return gated && event.type === "escalationResolved"
          ? ESCALATION_TARGET[event.choice]
          : null;
      case "done":
      case "failed":
      case "aborted":
        return null;
    }
  })();
  if (next === null)
    throw new IllegalTransitionError("Run", status, event.type);
  return next;
}

/** Statuses a Run never leaves. */
export const FINISHED_RUN_STATUSES: readonly RunStatus[] = [
  "done",
  "failed",
  "aborted",
];

export function isFinished(status: RunStatus): boolean {
  return FINISHED_RUN_STATUSES.includes(status);
}
