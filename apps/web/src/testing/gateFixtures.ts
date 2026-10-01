/**
 * Runs waiting for a person, for the decision screens' tests: at the Design
 * Gate, at the PR Gate, and escalated.
 */
import type { DocumentView, RunDetail, RunDocument } from "../api/types.js";
import { DETAIL } from "./fakeApi.js";

const document = (
  kind: RunDocument["kind"],
  status: RunDocument["status"],
  wouldMakeStale: RunDocument["wouldMakeStale"] = [],
): RunDocument => ({
  kind,
  version: 1,
  status,
  ownerAgent:
    kind === "uiSpec" || kind === "penpotDesign" ? "uiDesign" : "systemDesign",
  wouldMakeStale,
});

export const AT_DESIGN_GATE: RunDetail = {
  ...DETAIL,
  status: "awaitingDesignGate",
  slices: [],
  tasks: [],
  documents: [
    document("systemDesign", "inReview", ["uiSpec", "penpotDesign"]),
    document("apiContract", "inReview", ["uiSpec", "penpotDesign"]),
    document("uiSpec", "inReview"),
    document("penpotDesign", "inReview"),
  ],
  waiting: {
    for: "designGate",
    documents: [
      { kind: "systemDesign", version: 1 },
      { kind: "apiContract", version: 1 },
      { kind: "uiSpec", version: 1 },
      { kind: "penpotDesign", version: 1 },
    ],
  },
};

export const CONTENTS: Partial<Record<RunDocument["kind"], DocumentView>> =
  Object.fromEntries(
    AT_DESIGN_GATE.documents.map(({ kind, version, status, ownerAgent }) => [
      kind,
      { kind, version, status, ownerAgent, content: `# ${kind}\ncontent` },
    ]),
  );

export const AT_PR_GATE: RunDetail = {
  ...DETAIL,
  status: "awaitingPrGate",
  pullRequest: {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    draft: false,
  },
  slices: DETAIL.slices.map((slice, index) => ({
    ...slice,
    status: "passed",
    commitSha: `c0ffee${index}abcdef`,
  })),
  tasks: [],
  documents: [document("systemDesign", "approved")],
  reviews: [
    {
      findings: [
        {
          ruleId: "SEC-01",
          severity: "blocking",
          source: "codeReview",
          file: "src/server/app.ts",
          line: 3,
          message: "The API key is in the source.",
          suggestion: null,
        },
      ],
      stopReason: "answered",
      problems: [],
      createdAt: "2026-09-29T09:00:00.000Z",
    },
    {
      findings: [
        {
          ruleId: "REUSE-01",
          severity: "major",
          source: "codeReview",
          file: "src/server/notes.ts",
          line: 42,
          message: "Duplicated tag parsing logic",
          suggestion: "Extract to packages/shared/tags.ts.",
        },
        {
          ruleId: "CLEAN-02",
          severity: "minor",
          source: "linter",
          file: "src/server/routes.ts",
          line: 0,
          message: "Leftover console.log",
          suggestion: null,
        },
      ],
      stopReason: "answered",
      problems: [],
      createdAt: "2026-09-29T10:00:00.000Z",
    },
  ],
  waiting: {
    for: "prGate",
    pullRequest: {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      draft: false,
    },
  },
};

export const ESCALATED: RunDetail = {
  ...DETAIL,
  status: "escalated",
  documents: [
    document("apiContract", "approved"),
    document("uiSpec", "approved"),
  ],
  waiting: {
    for: "escalation",
    id: "escalation-1",
    trigger: "loop",
    summary: "The same failure came back after a fix.",
    slice: "Sign in",
    reports: [
      {
        step: "smoke",
        failingTest: "POST /api/bookings",
        file: "src/server/bookings.ts",
        endpoint: "POST /api/bookings",
        error: "409 Conflict",
        cause: null,
        suspectedOwner: "backendCoding",
        occurrences: 2,
      },
    ],
    workingMemory: [
      { role: "backendCoding", note: "Tried normalising to UTC; still 409." },
    ],
    brief: null,
    openDraftPrOnAbort: true,
  },
};
