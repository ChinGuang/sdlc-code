/**
 * Title and description of the pull request a Run opens: a ready PR when the Run
 * completes (PR Gate), a Draft PR when it is aborted or fails (UML diagram 3b).
 */

/** A non-blocking Finding carried into the PR description. */
export type PullRequestFinding = {
  ruleId: string;
  location: string;
  message: string;
  suggestion?: string;
};

type RunSummary = { runId: string; requestTitle: string; summary: string };

/** How a Run ended, with what its pull request must report. */
export type RunOutcome =
  | (RunSummary & {
      outcome: "complete";
      slices: string[];
      findings: PullRequestFinding[];
    })
  | (RunSummary & {
      outcome: "aborted" | "failed";
      /** Why the Run stopped, e.g. "Retry Budget exhausted on Todos CRUD". */
      stopReason: string;
      /** Slices with a Slice Commit; the only code in the Draft PR. */
      passedSlices: string[];
      totalSlices: number;
      /** The Slice that was in progress, if any; its code is never included. */
      failedSlice: { name: string; issueReports: string[] } | null;
      workingMemory: string;
    });

const TITLE_LIMIT = 256;
const BODY_LIMIT = 65_536;
const TRUNCATED = "\n\n…(truncated)";

export function pullRequestTitle(run: RunOutcome): string {
  const title = oneLine(run.requestTitle);
  if (run.outcome === "complete") return truncate(title, TITLE_LIMIT);
  const label = run.outcome === "aborted" ? "[Aborted]" : "[Failed]";
  const progress = ` — ${run.passedSlices.length} of ${run.totalSlices} slices`;
  return `${label} ${truncate(title, TITLE_LIMIT - label.length - 1 - progress.length)}${progress}`;
}

export function pullRequestBody(run: RunOutcome): string {
  const sections =
    run.outcome === "complete"
      ? [
          "## Summary",
          run.summary,
          "## Slices",
          run.slices.map(passedSlice).join("\n"),
          "## Non-blocking Findings",
          run.findings.length === 0
            ? "No non-blocking Findings."
            : run.findings.map(formatFinding).join("\n"),
        ]
      : [
          `> This Run was **${run.outcome}** after ${run.passedSlices.length} of ${run.totalSlices} slices. Only Slices that passed testing are included; code from the unfinished Slice is not.`,
          "## Why it stopped",
          run.stopReason,
          "## Summary",
          run.summary,
          "## Slices",
          [
            ...run.passedSlices.map(passedSlice),
            ...(run.failedSlice
              ? [`- [ ] ${run.failedSlice.name} (not included)`]
              : []),
          ].join("\n"),
          ...(run.failedSlice
            ? [
                "## Issue Reports",
                run.failedSlice.issueReports.length === 0
                  ? "None recorded."
                  : run.failedSlice.issueReports
                      .map((issue) => `- ${issue}`)
                      .join("\n"),
              ]
            : []),
          "## Working Memory",
          run.workingMemory,
        ];
  const footer = `---\nOpened by sdlc-code Run \`${run.runId}\`.`;
  const separator = "\n\n";
  const body = truncate(
    noMentions(sections.join(separator)),
    BODY_LIMIT - separator.length - footer.length,
    TRUNCATED,
  );
  return `${body}${separator}${footer}`;
}

function passedSlice(slice: string): string {
  return `- [x] ${slice}`;
}

function formatFinding(finding: PullRequestFinding): string {
  const line = `- **${finding.ruleId}** \`${finding.location}\` — ${finding.message}`;
  return finding.suggestion
    ? `${line}\n  Suggestion: ${finding.suggestion}`
    : line;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number, marker = "…"): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit - marker.length)}${marker}`;
}

/** Model-written text must not ping GitHub users or teams. */
function noMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9])/g, "@​");
}
