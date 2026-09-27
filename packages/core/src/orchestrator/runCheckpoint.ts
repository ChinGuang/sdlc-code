/**
 * What a Run carries from one Step to the next, written down (CONTEXT.md
 * "Checkpoint", UML diagram 9). The Orchestrator kept this in memory, so a Run
 * that stopped — a spent Token Budget, a closed laptop, a crash — could only be
 * started again from its first Slice.
 *
 * A Checkpoint holds decisions and evidence, never a Transcript: what a Slice
 * already failed on, the revisions a person asked for, and the hint an
 * Escalation left. A resumed Run rebuilds its context from this and the Steps'
 * Working Memory.
 */
import { z } from "zod";
import { AGENT_ROLES } from "../agentRoles.js";
import { DOCUMENT_KINDS } from "../domain/documentLifecycle.js";
import { TEST_STEPS } from "@sdlc-code/stack-profiles";
import type { IssueReport } from "../agents/testing/issueReports.js";
import type { Revision } from "./designGate.js";
import type { SliceHistory } from "./sliceRunner.js";

/**
 * `satisfies` is the link to IssueReport: a field added there and not here
 * stops this file compiling, rather than being dropped from every resume.
 */
const IssueReportSchema = z.strictObject({
  step: z.union([z.enum(TEST_STEPS), z.literal("sandbox")]),
  failingTest: z.string().nullable(),
  file: z.string().nullable(),
  endpoint: z.string().nullable(),
  error: z.string(),
  evidence: z.string(),
  suspectedOwner: z.enum(["backendCoding", "frontendCoding"]).nullable(),
  signature: z.string(),
  occurrences: z.number().int().positive(),
}) satisfies z.ZodType<IssueReport>;

const SliceHistorySchema = z.strictObject({
  earlier: z.strictObject({
    backend: z.array(IssueReportSchema),
    frontend: z.array(IssueReportSchema),
    design: z.array(IssueReportSchema),
  }),
  retryBaseline: z.strictObject({
    backend: z.number().int().nonnegative().optional(),
    frontend: z.number().int().nonnegative().optional(),
  }),
});

const RevisionSchema = z.strictObject({
  agentRole: z.enum(AGENT_ROLES),
  documentKind: z.enum(DOCUMENT_KINDS),
  comments: z.string(),
});

/**
 * A Checkpoint written by any other version of this shape is ignored rather
 * than guessed at, whether it is older or newer: the Run starts its current
 * Slice again, which is safe.
 */
export const CHECKPOINT_VERSION = 1;

export const CheckpointPayloadSchema = z.strictObject({
  version: z.literal(CHECKPOINT_VERSION),
  /** Documents a person or an Issue Report sent back, not yet revised. */
  revisions: z.array(RevisionSchema),
  /** What each unfinished Slice has already failed on, by Slice id. */
  histories: z.record(z.string(), SliceHistorySchema),
  /** The hint an Escalation left for a Slice's next attempt, by Slice id. */
  hints: z.record(z.string(), z.string()),
});

export type CheckpointPayload = z.infer<typeof CheckpointPayloadSchema>;

/** What the Orchestrator holds for a Run between Steps. */
export type RunMemoryState = {
  revisions: Revision[];
  histories: Map<string, SliceHistory>;
  hints: Map<string, string>;
};

/**
 * The payload to save. The board PNGs a model with vision was given are left
 * out on purpose: they are bytes, they are design material rather than a
 * decision, and the UI Spec they were drawn from is an Approved Document. A
 * resumed Run builds its screens from the UI Spec alone. A design that is not
 * revised is never redrawn, so a vision-capable agent works without those
 * images for the rest of that Run.
 *
 * The run branch is not recorded either: it only ever moves forward by a Slice
 * Commit, so its head is already the last Slice that passed.
 */
export function checkpointPayload(memory: RunMemoryState): CheckpointPayload {
  return {
    version: CHECKPOINT_VERSION,
    revisions: memory.revisions.map((revision) => ({ ...revision })),
    histories: Object.fromEntries(
      [...memory.histories].map(([sliceId, history]) => [
        sliceId,
        {
          earlier: {
            backend: [...history.earlier.backend],
            frontend: [...history.earlier.frontend],
            design: [...history.earlier.design],
          },
          retryBaseline: { ...history.retryBaseline },
        },
      ]),
    ),
    hints: Object.fromEntries(memory.hints),
  };
}

/**
 * The memory a Checkpoint describes, or null when there is nothing usable:
 * no Checkpoint, or one this version does not understand. Either way the Run
 * continues without it, starting its current Slice fresh.
 */
export function memoryFromCheckpoint(payload: unknown): RunMemoryState | null {
  const parsed = CheckpointPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    revisions: parsed.data.revisions.map((revision) => ({ ...revision })),
    histories: new Map(
      Object.entries(parsed.data.histories).map(([sliceId, history]) => [
        sliceId,
        {
          earlier: history.earlier,
          retryBaseline: history.retryBaseline,
        },
      ]),
    ),
    hints: new Map(Object.entries(parsed.data.hints)),
  };
}
