// SPDX-License-Identifier: MPL-2.0
/**
 * What the CLI prints, worked out without printing it (board 06). Colour is a
 * parameter: a terminal gets it, a pipe, a file or NO_COLOR does not.
 */
import type { DocumentKind, RunDetail, RunEvent, RunSummary } from "./api.js";

export type Paint = Record<
  "green" | "blue" | "amber" | "red" | "purple" | "muted" | "bold",
  (text: string) => string
>;

const ansi =
  (open: string) =>
  (text: string): string =>
    `\u001b[${open}m${text}\u001b[0m`;

export const COLOUR: Paint = {
  green: ansi("38;2;118;185;0"),
  blue: ansi("38;2;76;154;255"),
  amber: ansi("38;2;245;165;36"),
  red: ansi("38;2;242;85;90"),
  purple: ansi("38;2;167;139;250"),
  muted: ansi("38;2;139;152;169"),
  bold: ansi("1"),
};

const same = (text: string) => text;
export const PLAIN: Paint = {
  green: same,
  blue: same,
  amber: same,
  red: same,
  purple: same,
  muted: same,
  bold: same,
};

/** The document names a person types: `api-contract`, as board 06 spells them. */
export const DOCUMENT_ARGS: Record<string, DocumentKind> = {
  "system-design": "systemDesign",
  "slice-plan": "slicePlan",
  "api-contract": "apiContract",
  "ui-spec": "uiSpec",
  penpot: "penpotDesign",
};

export const argOf = (kind: DocumentKind): string =>
  Object.entries(DOCUMENT_ARGS).find(([, one]) => one === kind)![0];

const ROLE_NAMES: Record<string, string> = {
  orchestrator: "Orchestrator",
  systemDesign: "System Design Agent",
  uiDesign: "UI Design Agent",
  backendCoding: "Backend Coding Agent",
  frontendCoding: "Frontend Coding Agent",
  testing: "Testing Agent",
  codeReview: "Code Review Agent",
};

export const roleName = (role: string) => ROLE_NAMES[role] ?? role;

/** Run ids are UUIDs; six characters tell them apart, as the dashboard does. */
export const shortId = (runId: string) => runId.slice(0, 6);

/** "612k", "2.0M". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

const STATUS: Record<RunDetail["status"], [string, keyof Paint]> = {
  designing: ["designing", "blue"],
  awaitingDesignGate: ["awaiting Design Gate", "amber"],
  building: ["coding", "blue"],
  reviewing: ["code review", "blue"],
  awaitingPrGate: ["awaiting PR Gate", "purple"],
  escalated: ["escalated", "red"],
  done: ["done", "green"],
  failed: ["failed", "red"],
  aborted: ["aborted", "muted"],
};

export function statusText(status: RunDetail["status"], paint: Paint): string {
  const [label, tone] = STATUS[status] ?? [status, "muted"];
  return paint[tone](label);
}

/** One line per Run: `27f388  escalated  1.3M / 2.0M  A calendar app…`. */
export function runLine(run: RunSummary, paint: Paint): string {
  const [label, tone]: [string, keyof Paint] =
    run.waitingFor === "designRetry"
      ? ["design failed", "amber"]
      : (STATUS[run.status] ?? [run.status, "muted"]);
  return [
    paint.bold(shortId(run.id)),
    paint[tone](label.padEnd(20)),
    paint.muted(
      `${formatTokens(run.tokensUsed)} / ${formatTokens(run.tokenBudget)}`.padEnd(
        12,
      ),
    ),
    run.projectRequest,
  ].join("  ");
}

/** Board 06's status: each Slice, the current one's lanes, what is waited on. */
export function statusLines(run: RunDetail, paint: Paint): string[] {
  const lines = [
    `${paint.bold(`#${shortId(run.id)}`)}  ${run.projectRequest}`,
    `  ${statusText(run.status, paint)}  ·  ${run.mode}  ·  tokens ${formatTokens(run.tokensUsed)} / ${formatTokens(run.tokenBudget)}`,
  ];
  const width = Math.max(
    0,
    ...run.slices.map(
      (slice, index) => `Slice ${index + 1} ${slice.title}`.length,
    ),
  );
  run.slices.forEach((slice, index) => {
    const name = `Slice ${index + 1} ${slice.title}`.padEnd(width + 2);
    const tasks = run.tasks.filter((task) => task.sliceId === slice.id);
    const retries = Math.max(0, ...tasks.map((task) => task.retriesSpent));
    switch (slice.status) {
      case "passed":
        lines.push(
          `  ${name}${paint.green(`✓ ${(slice.commitSha ?? "").slice(0, 7)}`)}`,
        );
        break;
      case "skipped":
        lines.push(`  ${paint.muted(`${name}skipped`)}`);
        break;
      case "pending":
        lines.push(`  ${paint.muted(`${name}pending`)}`);
        break;
      default: {
        const lanes = tasks
          .map(
            (task) =>
              `${task.role === "backendCoding" ? "backend" : "frontend"} ${laneWord(task)}`,
          )
          .join("  ");
        lines.push(
          `  ${name}${paint.blue(`● ${slice.status === "testing" ? "testing" : "coding"}`)}${lanes ? `  ${lanes}` : ""}${retries > 0 ? paint.amber(`  retries ${retries}/3`) : ""}`,
        );
      }
    }
  });
  if (run.slices.length === 0)
    lines.push(paint.muted("  No Slice Plan yet: the Run is designing."));
  lines.push(...waitingLines(run, paint));
  return lines;
}

function laneWord(task: RunDetail["tasks"][number]): string {
  if (task.status === "done") return "done";
  if (task.status === "failed") return "failed";
  if (task.steps.some((step) => step.status === "running")) return "writing";
  return task.status === "pending" ? "waiting" : "between steps";
}

/** What the Run waits for, and the command that answers it. */
export function waitingLines(run: RunDetail, paint: Paint): string[] {
  const id = shortId(run.id);
  const { waiting } = run;
  switch (waiting.for) {
    case "designGate":
      return [
        paint.amber(
          `■ Design Gate: ${waiting.documents.length} documents to judge`,
        ),
        paint.muted(`  sdlccode gate show ${id}`),
      ];
    case "prGate":
      return [
        paint.purple(
          `■ PR Gate${waiting.pullRequest ? `: ${waiting.pullRequest.url}` : ""}`,
        ),
        paint.muted(`  sdlccode gate show ${id}`),
      ];
    case "escalation":
      return [
        paint.red(`■ Escalated: ${waiting.summary}`),
        paint.muted(`  sdlccode escalation show ${id}`),
      ];
    case "designRetry":
      return [
        paint.red(`■ The design failed: ${waiting.problem}`),
        paint.muted(`  sdlccode retry-design ${id}`),
      ];
    case "nothing":
      if (run.failure) return [paint.red(`■ Stopped: ${run.failure.summary}`)];
      if (run.pullRequest)
        return [
          paint.green(
            `${run.pullRequest.draft ? "Draft PR" : "PR"} #${run.pullRequest.number}: ${run.pullRequest.url}`,
          ),
        ];
      return [];
  }
}

/** One line for an event as it happens, or null for what is not worth one. */
export function eventLine(
  event: RunEvent,
  run: Pick<RunDetail, "slices">,
  paint: Paint,
): string | null {
  const time = paint.muted(
    new Date(event.happenedAt).toLocaleTimeString([], { hour12: false }),
  );
  const slice = (id: unknown) => {
    const index = run.slices.findIndex((one) => one.id === id);
    return index === -1 ? "a Slice" : `Slice ${index + 1}`;
  };
  const say = (who: string, what: string) => `${time}  ${who}  ${what}`;
  switch (event.type) {
    case "status":
      return say(
        paint.bold("Orchestrator"),
        `Run is now ${statusText(event.status as RunDetail["status"], paint)}`,
      );
    case "step":
      return event.phase === "started"
        ? say(
            paint.bold(roleName(String(event.role))),
            event.sliceId
              ? `started a Step on ${slice(event.sliceId)}`
              : "started a Step",
          )
        : null;
    case "checkpoint":
      return say(
        paint.bold("Orchestrator"),
        event.at === "committed"
          ? paint.green(`committed ${slice(event.sliceId)}`)
          : event.at === "merged"
            ? `merged both lanes of ${slice(event.sliceId)} → Test Run`
            : paint.amber(`sent ${slice(event.sliceId)} back to retry`),
      );
    case "testRun":
      return say(
        paint.bold("Testing Agent"),
        event.status === "passed"
          ? paint.green(`Test Run passed: ${String(event.summary)}`)
          : [
              paint.red(
                `Test Run ${String(event.status)}: ${String(event.summary)}`,
              ),
              ...(Array.isArray(event.issues) ? event.issues : []).map(
                (issue) => `            ${paint.red(String(issue))}`,
              ),
            ].join("\n"),
      );
    case "toolFailed":
      return say(
        paint.bold(roleName(String(event.role))),
        paint.amber(`${String(event.tool)} failed: ${String(event.problem)}`),
      );
    case "delivery":
      return say(
        paint.bold("Orchestrator"),
        event.status === "opened"
          ? paint.green(`opened ${String(event.detail)}`)
          : `kept the commits local: ${String(event.detail)}`,
      );
    case "reviewProblem":
    case "problem":
      return say(paint.bold("Orchestrator"), paint.red(String(event.problem)));
    case "exportFailed":
      return say(
        paint.bold("UI Design Agent"),
        paint.amber(
          `could not export ${String(event.screen)}: ${String(event.reason)}`,
        ),
      );
    default:
      return null;
  }
}

/** Statuses at which a Run waits for a person or has finished. */
export const RESTING = new Set<RunDetail["status"]>([
  "awaitingDesignGate",
  "awaitingPrGate",
  "escalated",
  "done",
  "failed",
  "aborted",
]);
