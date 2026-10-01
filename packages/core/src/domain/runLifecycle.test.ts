import { describe, expect, it } from "vitest";
import { IllegalTransitionError } from "./illegalTransitionError.js";
import {
  isFinished,
  nextRunStatus,
  RUN_EVENT_TYPES,
  RUN_STATUSES,
  type RunEvent,
  type RunMode,
  type RunStatus,
} from "./runLifecycle.js";

/** Every legal transition in UML diagram 3; anything not listed is illegal. */
const LEGAL: Array<[RunStatus, RunEvent, RunMode, RunStatus]> = [
  ["designing", { type: "documentsReady" }, "gated", "awaitingDesignGate"],
  ["designing", { type: "documentsReady" }, "auto", "building"],
  ["designing", { type: "designFailed" }, "auto", "failed"],

  // A person may stop a Run at any time before it finishes (T24g); at an
  // Escalation, abort is one of its choices instead.
  ...(
    [
      "designing",
      "awaitingDesignGate",
      "building",
      "reviewing",
      "awaitingPrGate",
    ] as const
  ).flatMap((status): Array<[RunStatus, RunEvent, RunMode, RunStatus]> => [
    [status, { type: "aborted" }, "gated", "aborted"],
    [status, { type: "aborted" }, "auto", "aborted"],
  ]),
  [
    "awaitingDesignGate",
    { type: "designChangesRequested" },
    "gated",
    "designing",
  ],
  ["awaitingDesignGate", { type: "designApproved" }, "gated", "building"],

  ["building", { type: "issueOwnedByDesignAgent" }, "gated", "designing"],
  ["building", { type: "issueOwnedByDesignAgent" }, "auto", "designing"],
  ["building", { type: "allSlicesCommitted" }, "gated", "reviewing"],
  ["building", { type: "allSlicesCommitted" }, "auto", "reviewing"],
  ["reviewing", { type: "blockingFindings" }, "gated", "building"],
  ["reviewing", { type: "blockingFindings" }, "auto", "building"],
  ["reviewing", { type: "prOpened" }, "gated", "awaitingPrGate"],
  ["reviewing", { type: "prOpened" }, "auto", "done"],
  ["awaitingPrGate", { type: "prChangesRequested" }, "gated", "building"],
  ["awaitingPrGate", { type: "prApproved" }, "gated", "done"],

  ...(
    ["retryBudget", "tokenBudget", "loop", "undecidableOwner"] as const
  ).flatMap((trigger): Array<[RunStatus, RunEvent, RunMode, RunStatus]> => [
    ["building", { type: "limitHit", trigger }, "gated", "escalated"],
    ["building", { type: "limitHit", trigger }, "auto", "failed"],
  ]),
  ...(["retryBudget", "tokenBudget"] as const).flatMap(
    (trigger): Array<[RunStatus, RunEvent, RunMode, RunStatus]> => [
      ["reviewing", { type: "limitHit", trigger }, "gated", "escalated"],
      ["reviewing", { type: "limitHit", trigger }, "auto", "failed"],
    ],
  ),

  [
    "escalated",
    { type: "escalationResolved", choice: "retryWithHint" },
    "gated",
    "building",
  ],
  [
    "escalated",
    { type: "escalationResolved", choice: "skipSlice" },
    "gated",
    "building",
  ],
  [
    "escalated",
    { type: "escalationResolved", choice: "editDocuments" },
    "gated",
    "designing",
  ],
  [
    "escalated",
    { type: "escalationResolved", choice: "abort" },
    "gated",
    "aborted",
  ],
  // A Run whose plan finished with no pull request to judge (T20).
  ["reviewing", { type: "nothingToDeliver" }, "gated", "done"],
  ["reviewing", { type: "nothingToDeliver" }, "auto", "done"],
];

/** One sample of every event shape, including every payload variant. */
const ALL_EVENTS: RunEvent[] = [
  { type: "aborted" },
  { type: "documentsReady" },
  { type: "designFailed" },
  { type: "designChangesRequested" },
  { type: "designApproved" },
  { type: "issueOwnedByDesignAgent" },
  { type: "allSlicesCommitted" },
  { type: "blockingFindings" },
  { type: "prOpened" },
  { type: "nothingToDeliver" },
  { type: "prChangesRequested" },
  { type: "prApproved" },
  ...(["retryBudget", "tokenBudget", "loop", "undecidableOwner"] as const).map(
    (trigger): RunEvent => ({ type: "limitHit", trigger }),
  ),
  ...(["retryWithHint", "editDocuments", "skipSlice", "abort"] as const).map(
    (choice): RunEvent => ({ type: "escalationResolved", choice }),
  ),
];

const key = (status: RunStatus, event: RunEvent, mode: RunMode) =>
  JSON.stringify([status, event, mode]);
const legalKeys = new Set(LEGAL.map(([s, e, m]) => key(s, e, m)));

describe("nextRunStatus", () => {
  it("covers every event type", () => {
    expect(new Set(ALL_EVENTS.map((e) => e.type))).toEqual(
      new Set(RUN_EVENT_TYPES),
    );
  });

  it.each(LEGAL)("%s + %j (%s) → %s", (status, event, mode, expected) => {
    expect(nextRunStatus(status, event, mode)).toBe(expected);
  });

  const illegal = RUN_STATUSES.flatMap((status) =>
    ALL_EVENTS.flatMap((event) =>
      (["gated", "auto"] as const)
        .filter((mode) => !legalKeys.has(key(status, event, mode)))
        .map((mode): [RunStatus, RunEvent, RunMode] => [status, event, mode]),
    ),
  );

  it(`rejects all ${illegal.length} other combinations`, () => {
    for (const [status, event, mode] of illegal) {
      expect(
        () => nextRunStatus(status, event, mode),
        key(status, event, mode),
      ).toThrow(IllegalTransitionError);
    }
  });

  it("names the status and event in the error", () => {
    expect(() =>
      nextRunStatus("done", { type: "prApproved" }, "gated"),
    ).toThrow(/Run cannot handle "prApproved" while "done"/);
  });
});

describe("isFinished", () => {
  it("is true only for done, failed and aborted", () => {
    expect(RUN_STATUSES.filter(isFinished)).toEqual([
      "done",
      "failed",
      "aborted",
    ]);
  });
});
