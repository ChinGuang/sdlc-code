// SPDX-License-Identifier: MPL-2.0
/**
 * One real Run, end to end, from a terminal. The wiring lives in the runtime
 * (src/runtime/runRuntime.ts), which the local server uses too; this script is
 * the arguments, the printing and your answers at the Gates.
 *
 *   pnpm --filter @sdlc-code/core run:real "Build a todo app" [--auto] [--budget 2000000]
 *
 * --repo owner/name pushes the Slice Commits there and opens the pull request;
 * --agents-md points at the user's own Review Standard (T19).
 *
 * A Run that stopped is continued rather than started again, with a new total
 * to spend; --resume takes a Run id, or the newest unfinished Run without one:
 *
 *   pnpm --filter @sdlc-code/core run:real --resume --auto --budget 4000000
 *
 * Needs NEBIUS_API_KEY, NEBIUS_AI_PROJECT and PENPOT_MCP_URL, and the Penpot
 * tab open with the MCP plugin connected. It spends tokens and sandbox credit.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  createRunRuntime,
  penpotPageUrl,
  type DocumentKind,
  type RuntimeEvent,
} from "../src/index.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  const next = at === -1 ? undefined : args[at + 1];
  // "--resume --auto" means resume the newest Run, not a Run called "--auto".
  return next?.startsWith("--") ? undefined : next;
};
const projectRequest =
  args.find(
    (argument) => !argument.startsWith("--") && args.indexOf(argument) === 0,
  ) ??
  "Build a todo app where a user can add todos, mark them done and delete them.";
const mode = flag("auto") ? "auto" : "gated";
const targetRepo = value("repo");
if (targetRepo && !/^[\w.-]+\/[\w.-]+$/.test(targetRepo)) {
  console.error(`--repo must be "owner/name", not "${targetRepo}".`);
  process.exit(1);
}
const tokenBudget = Number(value("budget") ?? 2_000_000);
const dataDir =
  value("data") ??
  fileURLToPath(new URL("../../../.sdlc-runs", import.meta.url));
const userStandardsFile = value("agents-md");

/** What is happening, one line each, as the runtime reports it. */
function print(event: RuntimeEvent): void {
  switch (event.type) {
    case "agentTurn":
      console.log(`  ${event.role}: ${event.toolCalls.join(", ") || "answer"}`);
      return;
    case "toolFailed":
      console.log(
        `    ${event.tool} failed: ${event.problem.slice(0, 160).replaceAll("\n", " | ")}`,
      );
      return;
    case "checkpoint":
      console.log(`  checkpoint: ${event.at}`);
      return;
    case "testRun":
      console.log(
        `  Test Run ${event.status} in ${event.durationSeconds ?? "?"}s (${event.cost ?? 0}): ${event.summary}`,
      );
      for (const issue of event.issues) console.log(`    ${issue}`);
      return;
    case "exportFailed":
      console.log(
        `  no PNG of "${event.screen}": ${event.reason} (the design is drawn; only this image is missing)`,
      );
      return;
    case "reviewProblem":
      console.log(`  review: ${event.problem}`);
      return;
    case "delivery":
      console.log(`  delivery: ${event.detail}`);
      return;
    case "problem":
      console.log(`  ${event.problem}`);
      return;
    case "status":
      return;
  }
}

const runtime = createRunRuntime({
  dataDir,
  env: process.env,
  configPath: fileURLToPath(
    new URL("../../../sdlc-code.config.json", import.meta.url),
  ),
  userStandards: async () =>
    userStandardsFile ? readFileSync(userStandardsFile, "utf8") : null,
  events: {
    run: print,
    penpot: ({ kind, attempt, delayMs }) => {
      const waiting = `(waiting ${delayMs / 1000}s, attempt ${attempt})`;
      console.log(
        `  ${
          {
            suspended: `Penpot tab is asleep: click it to wake it ${waiting}`,
            disconnected: `Penpot plugin is not connected: open the file and start the plugin ${waiting}`,
            unavailable: `Penpot did not answer in time ${waiting}`,
            execution: `Penpot could not do that ${waiting}`,
          }[kind]
        }`,
      );
    },
  },
});
const { runs, documents, slices, orchestrator } = runtime;

/**
 * A new Run, or the one --resume names (the newest unfinished Run when it names
 * none). A resumed Run keeps its design, its Slice Commits and what its Slices
 * already failed on; --budget gives it a new total to spend.
 */
const run = flag("resume") ? await resuming() : await starting();

async function starting() {
  return runtime.startRun({ projectRequest, mode, tokenBudget, targetRepo });
}

async function resuming() {
  const id = value("resume");
  const unfinished = runs.listUnfinishedRuns();
  const found = id ? runs.getRun(id) : unfinished.at(-1);
  if (!found) {
    console.error(
      id
        ? `No Run ${id}.`
        : "No unfinished Run to resume. Start one without --resume.",
    );
    process.exit(1);
  }
  const ready = value("budget")
    ? runs.setTokenBudget(found.id, tokenBudget)
    : found;
  // Whatever was in flight when the Run stopped is thrown away, not guessed at.
  const { discardedSteps, hadCheckpoint } = await runtime.resume(ready.id);
  console.log(
    `Resuming: ${discardedSteps} unfinished Step${discardedSteps === 1 ? "" : "s"} discarded, ${hadCheckpoint ? "continuing from its Checkpoint" : "no Checkpoint to continue from"}.`,
  );
  return ready;
}

const runDir = runtime.runDir(run.id);
const repoDir = runtime.repoDir(run.id);
console.log(
  `Run ${run.id} (${run.mode}, ${run.tokensUsed.toLocaleString()} of ${run.tokenBudget.toLocaleString()} tokens spent)\n  ${run.projectRequest}\n  Files: ${runDir}`,
);

/**
 * Your answers: typed at a terminal, or piped in (one per line) for an
 * unattended run. Piped input ends long before the first question is asked,
 * so it is read up front rather than through readline.
 */
async function answering() {
  if (process.stdin.isTTY) {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return {
      ask: (question: string) => readline.question(question),
      close: () => readline.close(),
    };
  }
  const piped: string[] = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) piped.push(chunk);
  const answers = piped.join("").split(/\r?\n/);
  return {
    ask: async (question: string) => {
      const answer = answers.shift() ?? "";
      console.log(`${question}${answer || "(no answer left)"}`);
      return answer;
    },
    close: () => {},
  };
}

const ask = await answering();

function report(): void {
  const current = runs.getRun(run.id)!;
  const built = slices
    .listSlices(run.id)
    .map((slice) => `${slice.title} (${slice.status})`)
    .join(", ");
  console.log(
    `\n[${current.status}] ${current.tokensUsed.toLocaleString()}/${current.tokenBudget.toLocaleString()} tokens · ${built}`,
  );
}

/** Your Verdict on each document the Design Gate is asking about. */
async function decideDesign(): Promise<void> {
  const inReview = documents
    .listLatest(run.id)
    .filter((document) => document.status === "inReview");
  console.log(
    `\nDesign Gate: ${inReview.map((d) => `${d.kind} v${d.version}`).join(", ")}`,
  );
  console.log(`  Documents: ${runDir} (or the database)`);
  const penpotDesign = documents.getLatest(run.id, "penpotDesign");
  const page = penpotDesign
    ? (JSON.parse(penpotDesign.content) as {
        page: { pageId: string; fileId: string | null };
      })
    : null;
  if (page?.page.fileId)
    console.log(
      `  Penpot: ${penpotPageUrl(process.env.PENPOT_ORIGIN ?? "https://design.penpot.app", page.page.fileId, page.page.pageId)}`,
    );

  const verdicts = [];
  for (const document of inReview) {
    console.log(`\n--- ${document.kind} v${document.version} ---`);
    console.log(document.content.slice(0, 2000));
    const answer = (await ask.ask(`Approve ${document.kind}? [Y/n] `)).trim();
    if (answer.toLowerCase().startsWith("n")) {
      const comments = await ask.ask("  What should change? ");
      verdicts.push({
        documentKind: document.kind as DocumentKind,
        decision: "requestChanges" as const,
        comments,
      });
    } else {
      verdicts.push({
        documentKind: document.kind as DocumentKind,
        decision: "approve" as const,
        comments: "",
      });
    }
  }
  orchestrator.decideDesign(run.id, verdicts);
}

/** Your choice at an Escalation (CONTEXT.md: the four choices). */
async function resolveEscalation(summary: string): Promise<void> {
  console.log(`\nEscalation: ${summary}`);
  const choice = (
    await ask.ask(
      "  1 retry with hint · 2 edit documents · 3 skip Slice · 4 abort [1] ",
    )
  ).trim();
  if (choice === "2") {
    const kind = (await ask.ask("  Which document? ")).trim();
    const comments = await ask.ask("  What should change? ");
    orchestrator.resolveEscalation(run.id, {
      choice: "editDocuments",
      edits: [{ documentKind: kind as DocumentKind, comments }],
    });
  } else if (choice === "3") {
    orchestrator.resolveEscalation(run.id, { choice: "skipSlice" });
  } else if (choice === "4") {
    orchestrator.resolveEscalation(run.id, { choice: "abort" });
  } else {
    const hint = await ask.ask("  Hint for the Coding Agents: ");
    orchestrator.resolveEscalation(run.id, { choice: "retryWithHint", hint });
  }
}

/** The PR Gate (diagram 8): approve what the Run built, or ask for changes. */
async function decidePullRequest(
  pullRequest: { number: number; url: string } | null,
): Promise<void> {
  console.log(
    `\nPR Gate: ${pullRequest ? `#${pullRequest.number} ${pullRequest.url}` : "no pull request"}`,
  );
  if (mode === "auto") {
    orchestrator.decidePullRequest(run.id, { choice: "approve" });
    return;
  }
  const answer = (await ask.ask("  [1] approve  [2] request changes: ")).trim();
  if (answer !== "2") {
    orchestrator.decidePullRequest(run.id, { choice: "approve" });
    return;
  }
  const comments = await ask.ask("  What needs changing: ");
  orchestrator.decidePullRequest(run.id, {
    choice: "requestChanges",
    comments,
  });
}

const started = Date.now();
try {
  for (;;) {
    const progress = await orchestrator.advance(run.id);
    report();
    if ("finished" in progress) {
      console.log(`Run ${progress.finished}.`);
      const failure = runs.getRun(run.id)!.failure;
      if (failure) console.log(`  ${failure.trigger}: ${failure.summary}`);
      break;
    }
    if (progress.waitingFor === "designGate") {
      await decideDesign();
      continue;
    }
    if (progress.waitingFor === "escalation") {
      await resolveEscalation(progress.escalation.summary);
      continue;
    }
    if (progress.waitingFor === "designRetry") {
      console.log(`\nThe design failed: ${progress.problem}`);
      const again = await ask.ask("Design again? [y/N] ");
      if (!/^y/i.test(again.trim())) break;
      orchestrator.retryDesign(run.id);
      continue;
    }
    await decidePullRequest(progress.pullRequest);
  }
  const commits = slices
    .listSlices(run.id)
    .filter((slice) => slice.commitSha !== null);
  console.log(
    `\n${commits.length} Slice Commit${commits.length === 1 ? "" : "s"} in ${repoDir} on ${run.targetRepo.runBranch}`,
  );
  console.log(
    `  See them: git --git-dir="${repoDir}" log --stat ${run.targetRepo.runBranch}`,
  );
  console.log(
    `  Try the app: git clone "${repoDir}" app && cd app && npm install && npm run dev`,
  );
} finally {
  ask.close();
  // Read before closing: close() closes the database too.
  const spent = runs.getRun(run.id)!.tokensUsed;
  await runtime.close();
  console.log(
    `Done in ${((Date.now() - started) / 60_000).toFixed(1)} minutes, ${spent.toLocaleString()} tokens.`,
  );
}
