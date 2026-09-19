/**
 * Title and description of the pull request a Run opens: a ready PR when the Run
 * completes (PR Gate), a Draft PR when it is aborted or fails (UML diagram 3b).
 */

/** A non-blocking Finding carried into the PR description. */
export type PrFinding = { ruleId: string; location: string; message: string };

type RunText = { runId: string; requestTitle: string; summary: string };

export type PullRequestText =
  | (RunText & {
      outcome: "complete";
      slices: string[];
      findings: PrFinding[];
    })
  | (RunText & {
      outcome: "aborted" | "failed";
      /** Slices with a Slice Commit; the only code in the Draft PR. */
      passedSlices: string[];
      totalSlices: number;
      /** The Slice that was in progress, if any; its code is never included. */
      failedSlice: { name: string; issueReports: string[] } | null;
      workingMemory: string;
    });

const TITLE_LIMIT = 256;
const BODY_LIMIT = 65_536;

export function pullRequestTitle(pr: PullRequestText): string {
  const title = oneLine(pr.requestTitle);
  if (pr.outcome === "complete") return truncate(title, TITLE_LIMIT);
  const label = pr.outcome === "aborted" ? "[Aborted]" : "[Failed]";
  const progress = ` — ${pr.passedSlices.length} of ${pr.totalSlices} slices`;
  return `${label} ${truncate(title, TITLE_LIMIT - label.length - 1 - progress.length)}${progress}`;
}

export function pullRequestBody(pr: PullRequestText): string {
  const sections =
    pr.outcome === "complete"
      ? [
          "## Summary",
          pr.summary,
          "## Slices",
          pr.slices.map((slice) => `- [x] ${slice}`).join("\n"),
          "## Non-blocking Findings",
          pr.findings.length === 0
            ? "No non-blocking Findings."
            : pr.findings.map(formatFinding).join("\n"),
        ]
      : [
          `> This Run was **${pr.outcome}** after ${pr.passedSlices.length} of ${pr.totalSlices} slices. Only Slices that passed testing are included; code from the unfinished Slice is not.`,
          "## Summary",
          pr.summary,
          "## Slices",
          [
            ...pr.passedSlices.map((slice) => `- [x] ${slice}`),
            ...(pr.failedSlice
              ? [`- [ ] ${pr.failedSlice.name} (not included)`]
              : []),
          ].join("\n"),
          ...(pr.failedSlice
            ? [
                "## Issue Reports",
                pr.failedSlice.issueReports.length === 0
                  ? "None recorded."
                  : pr.failedSlice.issueReports
                      .map((issue) => `- ${issue}`)
                      .join("\n"),
              ]
            : []),
          "## Working Memory",
          pr.workingMemory,
        ];
  const footer = `---\nOpened by sdlc-code Run \`${pr.runId}\` with NVIDIA Nemotron on Nebius Token Factory.`;
  const body = noMentions(sections.join("\n\n"));
  return `${truncate(body, BODY_LIMIT - footer.length - 20, "\n\n…(truncated)")}\n\n${footer}`;
}

function formatFinding(finding: PrFinding): string {
  return `- **${finding.ruleId}** \`${finding.location}\` — ${finding.message}`;
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
