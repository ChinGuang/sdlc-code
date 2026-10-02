/**
 * `sdlccode`: a Run from the terminal (T24, board 06). A thin client of the
 * local server, as the dashboard is: it starts Runs, follows them, and
 * answers the Gates and Escalations they wait at.
 */
import {
  ApiError,
  type DocumentKind,
  type EscalationBrief,
  type EscalationResolution,
  type HintSide,
  type RunDetail,
  type ServerApi,
} from "./api.js";
import {
  onlyFlags,
  parseArgs,
  parseTokens,
  UsageError,
  type Parsed,
} from "./args.js";
import {
  argOf,
  DOCUMENT_ARGS,
  eventLine,
  formatTokens,
  RESTING,
  roleName,
  runLine,
  shortId,
  statusLines,
  statusText,
  waitingLines,
  type Paint,
} from "./format.js";

export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export type CliDeps = {
  api: ServerApi;
  /** For what goes to `out`. */
  paint: Paint;
  /** For what goes to `err`, which may be a terminal when `out` is not. */
  errPaint?: Paint;
  /** Where the dashboard is, for links to a Run's page. */
  dashboardUrl: string;
};

const VERSION = "0.1.0"; // As apps/cli/package.json says.

const HELP = `Usage: sdlccode <command> [options]

Commands:
  list                                      Every Run, newest first
  run "<request>" [--repo owner/name] [--auto] [--budget 2M] [--detach]
                                            Start a Run and follow it until it needs you
  status <run> [--follow]                   Where a Run is; --follow prints what it does
  gate show <run> [<document>]              What the Run's Gate asks; a document in full
  gate approve <run> --all                  At the Design Gate: approve every document
  gate approve <run>                        At the PR Gate: approve the pull request
  gate request-changes <run> <document> "<comments>" [<document> "<comments>" ...]
                                            Send documents back; the rest are approved
  gate request-changes <run> "<comments>"   At the PR Gate: build the last Slice again
  escalation show <run>                     What stopped the Run, and the ways on
  escalation retry <run> "<hint>" [--side backend|frontend|both] [--budget 3M]
  escalation edit <run> <document> "<comments>" [--budget 3M]
  escalation skip <run> [--budget 3M]
  retry-design <run>                        Design again after a gated Run's design failed
  abort <run> [--no-draft-pr]               Stop a Run, whatever it is doing

<run> is a Run's id or its first characters, e.g. 27f388.
<document> is system-design, slice-plan, api-contract, ui-spec or penpot.
--budget raises a spent Token Budget: every way on but abort needs tokens.
--side sends a retry's hint to one Coding Agent; without it, to the side
  the Issue Reports point at, which escalation show names.

Options:
  --help       Show this help
  --version    Show the version

Environment:
  SDLC_API_URL        The server (default http://127.0.0.1:4317)
  SDLC_DASHBOARD_URL  The dashboard (default http://localhost:5173)`;

/** Flags that take a value; every other flag is a switch. */
const VALUED = new Set(["repo", "budget", "side"]);

/** Parses argv and runs a command; resolves to the process exit code. */
export async function runCli(
  argv: string[],
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  const [first] = argv;
  if (first === undefined || first === "--help" || first === "-h") {
    io.out(HELP);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    io.out(`sdlccode ${VERSION}`);
    return 0;
  }
  try {
    const parsed = parseArgs(argv, VALUED);
    if (parsed.flags.has("help")) {
      io.out(HELP);
      return 0;
    }
    await command(parsed, io, deps);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\nRun sdlccode --help for the commands.`);
      return 2;
    }
    const paint = deps.errPaint ?? deps.paint;
    if (error instanceof ApiError) {
      io.err(paint.red(error.message));
      for (const problem of error.problems) io.err(`  ${problem}`);
      return 1;
    }
    // Not the person's to fix, but still one line rather than a stack trace.
    io.err(paint.red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

async function command(parsed: Parsed, io: CliIo, deps: CliDeps) {
  const [name, sub] = parsed.words;
  switch (name) {
    case "list":
      return list(parsed, io, deps);
    case "run":
      return run(parsed, io, deps);
    case "status":
      return status(parsed, io, deps);
    case "abort":
      return abort(parsed, io, deps);
    case "retry-design":
      return retryDesign(parsed, io, deps);
    case "gate":
      if (sub === "show") return gateShow(parsed, io, deps);
      if (sub === "approve") return gateApprove(parsed, io, deps);
      if (sub === "request-changes")
        return gateRequestChanges(parsed, io, deps);
      throw new UsageError(
        `gate needs show, approve or request-changes${sub ? `, not "${sub}"` : ""}.`,
      );
    case "escalation":
      if (sub === "show") return escalationShow(parsed, io, deps);
      if (sub === "retry" || sub === "edit" || sub === "skip")
        return escalationGoOn(sub, parsed, io, deps);
      throw new UsageError(
        `escalation needs show, retry, edit or skip${sub ? `, not "${sub}"` : ""}.`,
      );
    default:
      throw new UsageError(`Unknown command: ${name}`);
  }
}

async function list(parsed: Parsed, io: CliIo, { api, paint }: CliDeps) {
  onlyFlags(parsed, []);
  const runs = await api.listRuns();
  if (runs.length === 0)
    io.out(paint.muted('No Runs yet. Start one: sdlccode run "<request>"'));
  for (const one of runs) io.out(runLine(one, paint));
}

async function run(parsed: Parsed, io: CliIo, deps: CliDeps) {
  onlyFlags(parsed, ["repo", "auto", "budget", "detach"]);
  const [, request, ...extra] = parsed.words;
  if (!request?.trim())
    throw new UsageError('run needs the request: sdlccode run "<request>"');
  if (extra.length > 0)
    throw new UsageError("Put the request in quotes: it is one argument.");
  const { api, paint } = deps;
  const repo = parsed.flags.get("repo");
  const budget = parsed.flags.get("budget");
  const started = await api.startRun({
    projectRequest: request,
    mode: parsed.flags.has("auto") ? "auto" : "gated",
    tokenBudget: typeof budget === "string" ? parseTokens(budget) : 2_000_000,
    targetRepo: typeof repo === "string" ? repo : null,
  });
  io.out(
    `${paint.green("✓")} Run ${paint.bold(`#${shortId(started.id)}`)} started  ·  ${started.mode}  ·  budget ${formatTokens(started.tokenBudget)} tokens`,
  );
  if (parsed.flags.has("detach")) {
    io.out(paint.muted(`  sdlccode status ${shortId(started.id)} --follow`));
    return;
  }
  await follow(started.id, io, deps);
}

async function status(parsed: Parsed, io: CliIo, deps: CliDeps) {
  onlyFlags(parsed, ["follow"]);
  const runId = await findRun(deps.api, parsed.words[1]);
  if (parsed.flags.has("follow")) return follow(runId, io, deps);
  for (const line of statusLines(await deps.api.getRun(runId), deps.paint))
    io.out(line);
}

/**
 * Prints what the Run does as it happens, until it waits for a person or
 * finishes, then what it waits for and how to answer.
 */
async function follow(runId: string, io: CliIo, deps: CliDeps) {
  const { api, paint } = deps;
  let detail = await api.getRun(runId);
  if (detail.waiting.for === "designRetry") {
    // Waits for a person; statusLines below says so, and how to answer.
  } else if (!settled(detail) && !detail.advancing) {
    // Nothing is moving it: its loop stopped, and a restart resumes it.
    io.out(
      paint.amber(
        `#${shortId(runId)} is not moving: the server is not advancing it. Restarting the server resumes it.`,
      ),
    );
  } else if (!settled(detail)) {
    io.out(
      paint.muted(
        `Following #${shortId(runId)}; Ctrl+C stops following, not the Run.`,
      ),
    );
    const until = new AbortController();
    /** Reads the Run again; stops following once nothing moves it. */
    const reread = () =>
      void api.getRun(runId).then(
        (next) => {
          // A read that left earlier and answers later must not undo a newer one.
          if (next.lastSeq >= detail.lastSeq) detail = next;
          if (!next.advancing) until.abort();
        },
        () => {},
      );
    await api.follow(
      runId,
      detail.lastSeq,
      (event) => {
        // A failed design is said once, by the status below, not twice.
        const failedDesign =
          event.type === "problem" &&
          String(event.problem).startsWith("The design failed:");
        const line = failedDesign ? null : eventLine(event, detail, paint);
        if (line) io.out(line);
        // What a failed or aborted Run delivers comes just after its status.
        if (event.type === "delivery") return "stop";
        if (event.type === "status") {
          const status = event.status as RunDetail["status"];
          if (RESTING.has(status) && !OWES_DELIVERY.has(status)) return "stop";
        }
        // Slices named in later lines; a Run whose loop stopped is let go.
        if (
          event.type === "checkpoint" ||
          event.type === "status" ||
          event.type === "problem"
        )
          reread();
      },
      until.signal,
    );
    detail = await api.getRun(runId);
    // The stream ended without the Run resting: the server went away.
    if (!RESTING.has(detail.status) && detail.waiting.for !== "designRetry")
      io.out(
        paint.amber(
          `The server stopped sending; follow again with: sdlccode status ${shortId(runId)} --follow`,
        ),
      );
  }
  for (const line of statusLines(detail, paint)) io.out(line);
  const link = linkFor(detail, deps.dashboardUrl);
  if (link) io.out(paint.muted(`  or in the dashboard: ${link}`));
}

/** A failed or aborted Run delivers its Draft PR just after it stops. */
const OWES_DELIVERY = new Set<RunDetail["status"]>(["failed", "aborted"]);

/** Nothing more will happen without a person, not even a delivery. */
function settled(run: RunDetail): boolean {
  return (
    RESTING.has(run.status) &&
    !(OWES_DELIVERY.has(run.status) && !run.pullRequest && run.advancing)
  );
}

function linkFor(run: RunDetail, dashboardUrl: string): string | null {
  const base = `${dashboardUrl.replace(/\/+$/, "")}/#/runs/${run.id}`;
  switch (run.waiting.for) {
    case "designGate":
      return `${base}/design-gate`;
    case "prGate":
      return `${base}/review`;
    case "escalation":
    case "designRetry":
      return base;
    case "nothing":
      return null;
  }
}

async function gateShow(parsed: Parsed, io: CliIo, deps: CliDeps) {
  onlyFlags(parsed, []);
  const { api, paint } = deps;
  const runId = await findRun(api, parsed.words[2]);
  const document = parsed.words[3];
  if (document) {
    const view = await api.getDocument(runId, documentKind(document));
    io.out(
      paint.muted(
        `${document} v${view.version} · ${view.status} · ${roleName(view.ownerAgent)}`,
      ),
    );
    io.out(pretty(view.content));
    return;
  }
  const run = await api.getRun(runId);
  const id = shortId(run.id);
  if (run.waiting.for === "designGate") {
    const judged = new Set(run.waiting.documents.map((one) => one.kind));
    io.out(paint.amber(`Design Gate · #${id} ${run.projectRequest}`));
    for (const one of run.documents)
      io.out(
        `  ${argOf(one.kind).padEnd(15)}${judged.has(one.kind) ? paint.blue("in review".padEnd(18)) : paint.muted(one.status.padEnd(18))}${paint.muted(roleName(one.ownerAgent))}`,
      );
    if (run.screenshots.length > 0) {
      io.out("  Screens as drawn:");
      for (const shot of run.screenshots)
        io.out(
          `    ${shot.screen.padEnd(20)}${paint.blue(api.screenshotUrl(run.id, shot.version, shot.order))}`,
        );
    }
    io.out(
      paint.muted(`  Read one:        sdlccode gate show ${id} <document>`),
    );
    io.out(paint.muted(`  Approve them:    sdlccode gate approve ${id} --all`));
    io.out(
      paint.muted(
        `  Send one back:   sdlccode gate request-changes ${id} <document> "<comments>"`,
      ),
    );
    io.out(
      paint.muted(`  In the dashboard: ${linkFor(run, deps.dashboardUrl)!}`),
    );
    return;
  }
  if (run.waiting.for === "prGate") {
    io.out(paint.purple(`PR Gate · #${id} ${run.projectRequest}`));
    if (run.waiting.pullRequest) io.out(`  ${run.waiting.pullRequest.url}`);
    const findings = run.reviews.at(-1)?.findings ?? [];
    io.out(
      findings.length === 0
        ? paint.muted("  No Findings in the last review.")
        : `  Findings (${findings.length}), in the pull request's description:`,
    );
    for (const finding of findings)
      io.out(
        `  ${paint.blue(finding.ruleId.padEnd(10))} ${severity(finding.severity, paint)}  ${finding.message}  ${paint.muted(finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file)}`,
      );
    io.out(paint.muted(`  Approve:          sdlccode gate approve ${id}`));
    io.out(
      paint.muted(
        `  Send it back:     sdlccode gate request-changes ${id} "<comments>"`,
      ),
    );
    return;
  }
  io.out(`#${id} is ${statusText(run.status, paint)}: no Gate waits for you.`);
  for (const line of waitingLines(run, paint)) io.out(line);
}

function severity(level: string, paint: Paint): string {
  const text = level.padEnd(8);
  return level === "blocking"
    ? paint.red(text)
    : level === "major"
      ? paint.amber(text)
      : paint.muted(text);
}

/** JSON as a person reads it; anything else as it is. */
function pretty(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

async function gateApprove(parsed: Parsed, io: CliIo, deps: CliDeps) {
  onlyFlags(parsed, ["all"]);
  const { api, paint } = deps;
  const runId = await findRun(api, parsed.words[2]);
  const run = await api.getRun(runId);
  if (run.waiting.for === "designGate") {
    // Approving every document at once is said, not assumed.
    if (!parsed.flags.has("all"))
      throw new UsageError(
        `At the Design Gate, approve every document with --all, or send some back with gate request-changes.`,
      );
    const next = await api.decideDesign(
      runId,
      run.waiting.documents.map(({ kind }) => ({
        documentKind: kind,
        decision: "approve",
        comments: "",
      })),
    );
    io.out(
      `${paint.green("✓")} Approved ${run.waiting.documents.length} documents. The Run builds its Slices now.`,
    );
    return after(next, io, deps);
  }
  if (run.waiting.for === "prGate") {
    const next = await api.decidePullRequest(runId, { choice: "approve" });
    io.out(
      `${paint.green("✓")} Approved the pull request. Merging stays on GitHub.`,
    );
    return after(next, io, deps);
  }
  throw notAtGate(run, paint);
}

async function gateRequestChanges(parsed: Parsed, io: CliIo, deps: CliDeps) {
  onlyFlags(parsed, []);
  const { api, paint } = deps;
  const runId = await findRun(api, parsed.words[2]);
  const rest = parsed.words.slice(3);
  const run = await api.getRun(runId);
  if (run.waiting.for === "prGate") {
    const [comments, ...extra] = rest;
    if (!comments?.trim() || extra.length > 0)
      throw new UsageError(
        'At the PR Gate: sdlccode gate request-changes <run> "<comments>"',
      );
    const next = await api.decidePullRequest(runId, {
      choice: "requestChanges",
      comments: comments.trim(),
    });
    io.out(
      `${paint.amber("↺")} Sent back: the last Slice is built again with your comments.`,
    );
    return after(next, io, deps);
  }
  if (run.waiting.for !== "designGate") throw notAtGate(run, paint);
  if (rest.length === 0 || rest.length % 2 !== 0)
    throw new UsageError(
      'Name each document with its comments: sdlccode gate request-changes <run> <document> "<comments>"',
    );
  const changes = new Map<DocumentKind, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const kind = documentKind(rest[index]!);
    const comments = rest[index + 1]!.trim();
    if (!comments)
      throw new UsageError(`Say what should change in ${rest[index]!}.`);
    changes.set(kind, comments);
  }
  const judged = run.waiting.documents.map((one) => one.kind);
  for (const kind of changes.keys())
    if (!judged.includes(kind))
      throw new UsageError(
        `${argOf(kind)} is not in review at this Gate; these are: ${judged.map(argOf).join(", ")}.`,
      );
  const stale = [
    ...new Set(
      run.documents
        .filter((one) => changes.has(one.kind))
        .flatMap((one) => one.wouldMakeStale),
    ),
  ].filter((kind) => !changes.has(kind));
  const next = await api.decideDesign(
    runId,
    judged.map((kind) => ({
      documentKind: kind,
      decision: changes.has(kind) ? "requestChanges" : "approve",
      comments: changes.get(kind) ?? "",
    })),
  );
  io.out(
    `${paint.amber("↺")} Sent ${[...changes.keys()].map(argOf).join(", ")} back to ${[...new Set([...changes.keys()].map((kind) => roleName(run.documents.find((one) => one.kind === kind)?.ownerAgent ?? "")))].join(" and ")}; the rest are approved.`,
  );
  if (stale.length > 0)
    io.out(
      paint.amber(
        `! ${stale.map(argOf).join(", ")} marked stale: redone before the Gate re-opens`,
      ),
    );
  return after(next, io, deps);
}

async function escalationShow(parsed: Parsed, io: CliIo, deps: CliDeps) {
  onlyFlags(parsed, []);
  const { api, paint } = deps;
  const runId = await findRun(api, parsed.words[2]);
  const run = await api.getRun(runId);
  if (run.waiting.for !== "escalation") throw notEscalated(run, paint);
  const { waiting } = run;
  const id = shortId(run.id);
  const slice = run.slices.find((one) => one.title === waiting.slice);
  const retries = slice
    ? Math.max(
        0,
        ...run.tasks
          .filter((task) => task.sliceId === slice.id)
          .map((task) => task.retriesSpent),
      )
    : null;
  io.out(paint.red(`Escalated · #${id} ${run.projectRequest}`));
  io.out(`  ${waiting.summary}`);
  io.out(
    paint.muted(
      `  trigger ${waiting.trigger}${waiting.slice ? `  ·  Slice "${waiting.slice}"` : "  ·  in review"}${retries === null ? "" : `  ·  retries ${retries}/3`}  ·  tokens ${formatTokens(run.tokensUsed)} / ${formatTokens(run.tokenBudget)}`,
    ),
  );
  const { brief } = waiting;
  if (brief?.analysis) {
    const { analysis } = brief;
    io.out("  What went wrong:");
    io.out(`    Failing    ${analysis.failing}`);
    io.out(`    Tried      ${analysis.tried}`);
    io.out(`    Cause      ${analysis.cause}`);
    io.out(`    Suggested  ${paint.bold(CHOICE_NAMES[analysis.choice])}`);
  }
  if (brief?.withoutAnalysis) io.out(paint.muted(`  ${brief.withoutAnalysis}`));
  if (brief && brief.facts.length > 0) io.out("  Facts:");
  for (const fact of brief?.facts ?? []) io.out(`    - ${fact}`);
  if (waiting.reports.length > 0) io.out("  What kept failing:");
  for (const report of waiting.reports) {
    io.out(
      `    ${paint.red(`${report.step} › ${report.failingTest ?? report.endpoint ?? ""} → ${report.error}`)}${report.file ? paint.muted(`  ${report.file}`) : ""}`,
    );
    if (report.cause) io.out(paint.muted(`      ${report.cause}`));
  }
  if (waiting.workingMemory.length > 0) io.out("  What the agents tried:");
  for (const note of waiting.workingMemory) {
    io.out(`    ${paint.bold(roleName(note.role))}`);
    for (const line of note.note.split("\n")) io.out(`      ${line}`);
  }
  const spent = run.tokensUsed >= run.tokenBudget;
  const budget = spent ? ` --budget ${suggestedBudget(run)}` : "";
  if (waiting.slice)
    io.out(
      paint.muted(
        waiting.sideAtFault === "both"
          ? "  A retry's hint goes to both Coding Agents unless --side names one."
          : `  A retry's hint goes to the ${waiting.sideAtFault}, where the evidence points, unless --side says otherwise.`,
      ),
    );
  io.out("  Ways on:");
  const hint = brief?.analysis?.hint;
  // The hint came from a model that read the application's output, so it is
  // never pasted inside double quotes, where a shell would run `$(…)`. Single
  // quotes keep it literal in bash, zsh and PowerShell alike; one that holds
  // a single quote is shown on its own for the person to quote.
  const ready =
    hint && !hint.includes("'") ? `'${hint.replace(/\s+/g, " ")}'` : null;
  if (hint && !ready) io.out(`    Suggested hint: ${hint}`);
  io.out(
    paint.muted(
      `    sdlccode escalation retry ${id} ${ready ?? '"<hint>"'}${budget}`,
    ),
  );
  io.out(
    paint.muted(
      `    sdlccode escalation edit ${id} <document> "<comments>"${budget}`,
    ),
  );
  if (waiting.slice)
    io.out(paint.muted(`    sdlccode escalation skip ${id}${budget}`));
  io.out(paint.muted(`    sdlccode abort ${id} [--no-draft-pr]`));
  if (spent)
    io.out(
      paint.amber(
        "  The Token Budget is spent: every way on but abort needs --budget.",
      ),
    );
}

const HINT_SIDES = [
  "backend",
  "frontend",
  "both",
] as const satisfies readonly HintSide[];

const CHOICE_NAMES: Record<
  NonNullable<EscalationBrief["analysis"]>["choice"],
  string
> = {
  retryWithHint: "Retry with a hint",
  editDocuments: "Edit approved documents",
  skipSlice: "Skip this slice",
  abort: "Abort run",
};

async function escalationGoOn(
  choice: "retry" | "edit" | "skip",
  parsed: Parsed,
  io: CliIo,
  deps: CliDeps,
) {
  onlyFlags(parsed, choice === "retry" ? ["budget", "side"] : ["budget"]);
  const { api, paint } = deps;
  const runId = await findRun(api, parsed.words[2]);
  const side = parsed.flags.get("side");
  if (side !== undefined && !(HINT_SIDES as readonly unknown[]).includes(side))
    throw new UsageError(
      `--side is backend, frontend or both, not "${String(side)}".`,
    );
  const rest = parsed.words.slice(3);
  const budget = parsed.flags.get("budget");
  const more: { tokenBudget?: number } =
    typeof budget === "string" ? { tokenBudget: parseTokens(budget) } : {};
  let resolution: EscalationResolution;
  if (choice === "retry") {
    const [hint, ...extra] = rest;
    if (!hint?.trim() || extra.length > 0)
      throw new UsageError(
        'escalation retry needs one hint, in quotes: sdlccode escalation retry <run> "<hint>"',
      );
    resolution = {
      choice: "retryWithHint",
      hint: hint.trim(),
      // Without --side, the side the Issue Reports point at (T24i).
      ...(side ? { side: side as HintSide } : {}),
      ...more,
    };
  } else if (choice === "edit") {
    const [document, comments, ...extra] = rest;
    if (!document || !comments?.trim() || extra.length > 0)
      throw new UsageError(
        'escalation edit needs a document and comments: sdlccode escalation edit <run> <document> "<comments>"',
      );
    resolution = {
      choice: "editDocuments",
      edits: [
        { documentKind: documentKind(document), comments: comments.trim() },
      ],
      ...more,
    };
  } else {
    if (rest.length > 0)
      throw new UsageError("escalation skip takes only the Run.");
    resolution = { choice: "skipSlice", ...more };
  }
  const next = await api.resolveEscalation(runId, resolution);
  io.out(
    `${paint.green("✓")} ${
      choice === "retry"
        ? `Retrying with your hint${side && side !== "both" ? ` for the ${side}` : ""}.`
        : choice === "edit"
          ? "Sent to the document's owner; the Design Gate re-opens after."
          : "Skipped the Slice."
    }${more.tokenBudget ? ` Token Budget is now ${formatTokens(more.tokenBudget)}.` : ""}`,
  );
  return after(next, io, deps);
}

async function retryDesign(parsed: Parsed, io: CliIo, deps: CliDeps) {
  onlyFlags(parsed, []);
  const runId = await findRun(deps.api, parsed.words[1]);
  await deps.api.retryDesign(runId);
  io.out(`${deps.paint.green("✓")} Designing #${shortId(runId)} again.`);
  await follow(runId, io, deps);
}

async function abort(parsed: Parsed, io: CliIo, deps: CliDeps) {
  onlyFlags(parsed, ["no-draft-pr"]);
  const { api, paint } = deps;
  const runId = await findRun(api, parsed.words[1]);
  const draft = !parsed.flags.has("no-draft-pr");
  await api.abortRun(runId, draft);
  io.out(
    `${paint.red("■")} Aborted #${shortId(runId)}${draft ? "; a Draft PR is offered of the Slices that passed." : ", with no Draft PR."}`,
  );
  // Whether a Draft PR opened, or why not, is known only once it is delivered.
  await follow(runId, io, deps);
}

/** After a decision: where the Run went, and how to follow it. */
function after(run: RunDetail, io: CliIo, { paint }: CliDeps) {
  if (RESTING.has(run.status)) {
    for (const line of waitingLines(run, paint)) io.out(line);
    return;
  }
  io.out(paint.muted(`  sdlccode status ${shortId(run.id)} --follow`));
}

function notAtGate(run: RunDetail, paint: Paint): ApiError {
  return new ApiError(
    409,
    `#${shortId(run.id)} is ${statusText(run.status, paint)}: no Gate waits for a decision.`,
  );
}

function notEscalated(run: RunDetail, paint: Paint): ApiError {
  return new ApiError(
    409,
    `#${shortId(run.id)} is ${statusText(run.status, paint)}: it is not at an Escalation.`,
  );
}

function documentKind(arg: string): DocumentKind {
  const kind = DOCUMENT_ARGS[arg];
  if (!kind)
    throw new UsageError(
      `"${arg}" is not a document; use ${Object.keys(DOCUMENT_ARGS).join(", ")}.`,
    );
  return kind;
}

/**
 * A Run from what a person typed: its id, or its first characters (with or
 * without #), as long as only one Run starts with them.
 */
async function findRun(
  api: ServerApi,
  typed: string | undefined,
): Promise<string> {
  const prefix = typed?.replace(/^#/, "").trim().toLowerCase();
  if (!prefix)
    throw new UsageError(
      "Name the Run: its id, or its first characters (sdlccode list shows them).",
    );
  const matches = (await api.listRuns()).filter((one) =>
    one.id.toLowerCase().startsWith(prefix),
  );
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0)
    throw new ApiError(
      404,
      `No Run starts with "${prefix}". sdlccode list shows them.`,
    );
  throw new UsageError(
    `"${prefix}" starts ${matches.length} Runs: ${matches.map((one) => shortId(one.id)).join(", ")}. Type more of it.`,
  );
}

/**
 * A million more than was spent or allowed, whichever is more, rounded up to
 * the 0.1M it is printed with: never a budget that is already spent.
 */
export function suggestedBudget(
  run: Pick<RunDetail, "tokensUsed" | "tokenBudget">,
): string {
  const tokens =
    Math.ceil(
      (Math.max(run.tokensUsed, run.tokenBudget) + 1_000_000) / 100_000,
    ) * 100_000;
  return formatTokens(tokens);
}
