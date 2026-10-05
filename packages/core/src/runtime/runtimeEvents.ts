// SPDX-License-Identifier: MPL-2.0
/**
 * What a Run does, as it happens (T21). One stream of small events, so the
 * terminal can print them and the server can push them to a dashboard without
 * either of them knowing how a Run is wired.
 *
 * An event is something that happened, never a secret and never a whole
 * Transcript: enough to follow a Run, not enough to replay it.
 */
import type { RunStatus } from "../domain/runLifecycle.js";
import type { AgentRole } from "../agentRoles.js";
import type { PenpotErrorKind } from "@sdlc-code/clients";

export type RuntimeEvent = { runId: string } & (
  | { type: "status"; status: RunStatus }
  /**
   * A Step began or ended (CONTEXT.md "Step"): the unit a person follows, and
   * what the plan's stream is required to carry in order.
   */
  | {
      type: "step";
      phase: "started" | "completed" | "discarded";
      stepId: string;
      taskId: string;
      role: AgentRole;
      /** Null for a design Task, which belongs to no Slice. */
      sliceId: string | null;
    }
  /**
   * What the Run has spent of its Token Budget, after each model call: a
   * budget bar follows it without asking.
   */
  | { type: "tokens"; used: number; budget: number }
  /** One model turn: which tools it called, or an answer. */
  | { type: "agentTurn"; role: AgentRole; toolCalls: string[] }
  | { type: "toolFailed"; role: AgentRole; tool: string; problem: string }
  | {
      type: "checkpoint";
      at: "merged" | "committed" | "retrying";
      sliceId: string;
    }
  | {
      type: "testRun";
      status: "passed" | "failed" | "broken";
      /** "ok install, FAILED unit" or, when it broke, why. */
      summary: string;
      durationSeconds: number | null;
      cost: number | null;
      /** One line per Issue Report, as the Coding Agents will read them. */
      issues: string[];
    }
  /** The design is drawn; only this screen's PNG is missing. */
  | { type: "exportFailed"; screen: string; reason: string }
  /** Something that made a review less trustworthy than it looks. */
  | { type: "reviewProblem"; problem: string }
  | {
      type: "delivery";
      status: "opened" | "keptLocal";
      /** The pull request's URL, or why nothing was pushed. */
      detail: string;
    }
  | { type: "problem"; problem: string }
);

/** Penpot needs a person: its tab is asleep, gone, or not answering. */
export type PenpotWaitEvent = {
  type: "penpotWaiting";
  kind: PenpotErrorKind;
  attempt: number;
  delayMs: number;
};

/** Where a runtime sends what happens; every part of it is optional to use. */
export type RuntimeEventSink = {
  run?: (event: RuntimeEvent) => void;
  /** Not a Run's event: one browser tab serves every Run. */
  penpot?: (event: PenpotWaitEvent) => void;
};
