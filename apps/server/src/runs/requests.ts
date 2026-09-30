/**
 * What each route accepts, checked before anything reaches a Run (T21). A body
 * that does not fit is a 400 naming every problem, so a client fixes it in one
 * go rather than one field at a time.
 */
import { DOCUMENT_KINDS } from "@sdlc-code/core";
import { z } from "zod";

/** A model-sized request is not what this box is for; a book is a mistake. */
const MAX_REQUEST_CHARS = 10_000;
/** More than a Run could ever spend, and less than an accidental extra zero. */
const MAX_TOKEN_BUDGET = 50_000_000;

export const StartRunBody = z.strictObject({
  projectRequest: z.string().trim().min(1).max(MAX_REQUEST_CHARS),
  mode: z.enum(["gated", "auto"]).default("gated"),
  tokenBudget: z
    .number()
    .int()
    .positive()
    .max(MAX_TOKEN_BUDGET)
    .default(2_000_000),
  targetRepo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'a Target Repo is "owner/name"')
    .nullable()
    .optional(),
});

/** A document's kind in a URL: one a Run can have, or a 400 naming them. */
export const DocumentKindParam = z.enum(DOCUMENT_KINDS);

const Verdict = z.strictObject({
  documentKind: z.enum(DOCUMENT_KINDS),
  decision: z.enum(["approve", "requestChanges"]),
  comments: z.string().default(""),
});

export const DesignGateBody = z.strictObject({
  verdicts: z.array(Verdict).min(1),
});

/** A higher Token Budget: every way on but abort spends tokens. */
const RaisedBudget = z
  .number()
  .int()
  .positive()
  .max(MAX_TOKEN_BUDGET)
  .optional();

export const EscalationBody = z.discriminatedUnion("choice", [
  z.strictObject({
    choice: z.literal("retryWithHint"),
    hint: z.string().trim().min(1),
    tokenBudget: RaisedBudget,
  }),
  z.strictObject({
    choice: z.literal("editDocuments"),
    edits: z
      .array(
        z.strictObject({
          documentKind: z.enum(DOCUMENT_KINDS),
          comments: z.string().trim().min(1),
        }),
      )
      .min(1),
    tokenBudget: RaisedBudget,
  }),
  z.strictObject({
    choice: z.literal("skipSlice"),
    tokenBudget: RaisedBudget,
  }),
  z.strictObject({
    choice: z.literal("abort"),
    /** The dialog's checkbox; ticked unless a person unticks it (diagram 3b). */
    openDraftPrOnAbort: z.boolean().default(true),
  }),
]);

export const PullRequestGateBody = z.discriminatedUnion("choice", [
  z.strictObject({ choice: z.literal("approve") }),
  z.strictObject({
    choice: z.literal("requestChanges"),
    comments: z.string().trim().min(1),
  }),
]);

/**
 * The abort dialog's checkbox, named as the Escalation names it ("--no-draft-pr"
 * in the CLI): a Draft PR of what passed unless a person unticks it.
 */
export const AbortBody = z
  .strictObject({ openDraftPrOnAbort: z.boolean().default(true) })
  .default({ openDraftPrOnAbort: true });
