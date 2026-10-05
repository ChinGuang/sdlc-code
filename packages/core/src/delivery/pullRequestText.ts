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
      /** Slices that finished: the ones ticked in the Draft PR. */
      passedSlices: string[];
      totalSlices: number;
      /**
       * The Slice that was in progress, if any. Its work is in the Draft PR when
       * `pushedCommits` is above 0: a Slice that passed testing and was then sent
       * back (by Code Review) keeps its Slice Commits on the run branch.
       */
      failedSlice: {
        name: string;
        issueReports: string[];
        pushedCommits: number;
      } | null;
      workingMemory: string;
    });

const TITLE_LIMIT = 256;
const BODY_LIMIT = 65_536;
/** The agents' notes can be long; cut before they are folded, so the fold closes. */
const NOTES_LIMIT = 20_000;
const TRUNCATED = "\n\n…(truncated)";

export function pullRequestTitle(run: RunOutcome): string {
  const title = oneLine(run.requestTitle);
  if (run.outcome === "complete") return truncate(title, TITLE_LIMIT);
  const label = run.outcome === "aborted" ? "[Aborted]" : "[Failed]";
  const unfinished = run.failedSlice && run.failedSlice.pushedCommits > 0;
  const progress = ` — ${run.passedSlices.length} of ${run.totalSlices} slices${unfinished ? ", 1 unfinished" : ""}`;
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
          stoppedNote(run),
          "## Why it stopped",
          run.stopReason,
          "## Summary",
          run.summary,
          "## Slices",
          [
            ...run.passedSlices.map(passedSlice),
            ...(run.failedSlice ? [unfinishedSlice(run.failedSlice)] : []),
          ].join("\n"),
          ...(run.failedSlice
            ? [
                "## Issue Reports",
                run.failedSlice.issueReports.length === 0
                  ? "No failing test was recorded for this Slice."
                  : run.failedSlice.issueReports
                      .map((issue) => `- ${issue}`)
                      .join("\n"),
              ]
            : []),
          "## Working Memory",
          // The agents' own notes are long and rough: there, but folded away.
          `<details>
<summary>What the agents last wrote down</summary>

${foldable(run.workingMemory)}

</details>`,
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

type Stopped = Extract<RunOutcome, { outcome: "aborted" | "failed" }>;

/** The first line: what the Run did, and whether the unfinished Slice is in. */
function stoppedNote(run: Stopped): string {
  const progress = `${run.passedSlices.length} of ${run.totalSlices} slices`;
  const slice = run.failedSlice;
  if (!slice || slice.pushedCommits === 0)
    return `> This Run was **${run.outcome}** after ${progress}. Only Slices that finished are included${slice ? `; nothing of ${slice.name} is` : ""}.`;
  return `> This Run was **${run.outcome}** after ${progress}. **${slice.name}** did not finish, but the ${plural(slice.pushedCommits, "commit")} of it that passed testing ${slice.pushedCommits === 1 ? "is" : "are"} included.`;
}

function unfinishedSlice(slice: {
  name: string;
  pushedCommits: number;
}): string {
  return slice.pushedCommits === 0
    ? `- [ ] ${slice.name} (not included)`
    : `- [ ] ${slice.name} (unfinished; ${plural(slice.pushedCommits, "commit")} that passed testing included)`;
}

/** Notes safe to put inside <details>: bounded, and unable to close it early. */
function foldable(notes: string): string {
  return truncate(
    notes.replaceAll("</details>", "&lt;/details&gt;"),
    NOTES_LIMIT,
    TRUNCATED,
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
