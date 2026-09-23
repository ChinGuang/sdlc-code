/**
 * One real Run, end to end, from a terminal: the design agents on Token
 * Factory, the Design Gate answered by you, then each Slice coded by the
 * Coding Agents and tested in a Nebius Sandbox, committed as Slice Commits in
 * a local git repository.
 *
 *   pnpm --filter @sdlc-code/core run:real "Build a todo app" [--auto] [--budget 2000000]
 *
 * Needs NEBIUS_API_KEY, NEBIUS_AI_PROJECT and PENPOT_MCP_URL, and the Penpot
 * tab open with the MCP plugin connected. It spends tokens and sandbox credit.
 */
import {
  connectPenpotMcp,
  NebiusSandboxClient,
  TokenFactoryChatClient,
  type ChatClient,
} from "@sdlc-code/clients";
import { REACT_NODE, templateFiles } from "@sdlc-code/stack-profiles";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentDesignPhase,
  AgentRunOrchestrator,
  ChatAgentLoop,
  DocumentDesignGate,
  GitWorkspaceManager,
  LoopCodingAgent,
  LoopSystemDesignAgent,
  LoopUiDesignAgent,
  ModelOwnerJudge,
  openDatabase,
  OrchestratedSliceRunner,
  PenpotUiCanvas,
  penpotPageUrl,
  requestOptionsFor,
  RuleOwnerResolver,
  RunTokenBudget,
  runPageName,
  SandboxBaseSnapshots,
  SandboxTestingAgent,
  SandboxTestRunner,
  SqliteDocumentStore,
  SqliteEscalationStore,
  SqliteGateStore,
  SqliteRunStore,
  SqliteSliceStore,
  SqliteSnapshotStore,
  SqliteTaskStore,
  StepTranscript,
  loadAgentConfig,
  type AgentRole,
  type AgentTool,
  type DocumentKind,
  type TranscriptEvent,
} from "../src/index.js";
import { requireEnv } from "../../clients/scripts/requireEnv.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const projectRequest =
  args.find(
    (argument) => !argument.startsWith("--") && args.indexOf(argument) === 0,
  ) ??
  "Build a todo app where a user can add todos, mark them done and delete them.";
const mode = flag("auto") ? "auto" : "gated";
const tokenBudget = Number(value("budget") ?? 2_000_000);
const dataDir =
  value("data") ??
  fileURLToPath(new URL("../../../.sdlc-runs", import.meta.url));

const apiKey = requireEnv("NEBIUS_API_KEY");
const project = requireEnv("NEBIUS_AI_PROJECT");
const penpotUrl = requireEnv("PENPOT_MCP_URL");
const config = loadAgentConfig({
  path: fileURLToPath(
    new URL("../../../sdlc-code.config.json", import.meta.url),
  ),
  env: process.env,
});

mkdirSync(dataDir, { recursive: true });
const db = openDatabase(join(dataDir, "sdlc-code.db"));
const store = { db };
const runs = new SqliteRunStore(store);
const documents = new SqliteDocumentStore(store);
const slices = new SqliteSliceStore(store);
const tasks = new SqliteTaskStore(store);
const escalations = new SqliteEscalationStore(store);
const gate = new DocumentDesignGate({
  db,
  runs,
  documents,
  gates: new SqliteGateStore(store),
});

const run = runs.createRun({
  projectRequest,
  mode,
  targetRepo: {
    owner: "local",
    name: "app",
    baseBranch: "main",
    runBranch: "sdlc/run",
  },
  stackProfile: REACT_NODE.id,
  tokenBudget,
});
const runDir = join(dataDir, run.id);
console.log(
  `Run ${run.id} (${mode}, ${tokenBudget.toLocaleString()} tokens)\n  ${projectRequest}\n  Files: ${runDir}`,
);

const client: ChatClient = new TokenFactoryChatClient({
  apiKey,
  baseUrl: process.env.NEBIUS_BASE_URL || undefined,
});
const sandbox = new NebiusSandboxClient({
  token: apiKey,
  project,
  baseUrl: process.env.NEBIUS_SANDBOX_URL || undefined,
});
const budget = new RunTokenBudget(runs, run.id);

/** One agent loop, with its Transcript printed and stored when it has a Step. */
const loopFor =
  (role: AgentRole, maxIterations: number, stepId?: string) =>
  (tools: AgentTool[]) => {
    const transcript = stepId ? new StepTranscript(tasks, stepId) : null;
    return new ChatAgentLoop({
      client,
      request: requestOptionsFor(config.roles[role]),
      tools,
      maxIterations,
      budget,
      transcript: {
        record: (event: TranscriptEvent) => {
          transcript?.record(event);
          if (event.type === "assistant")
            console.log(
              `  ${role}: ${event.toolCalls.map((call) => call.name).join(", ") || "answer"}`,
            );
          if (event.type === "toolResult" && event.problem)
            console.log(
              `    ${event.name} failed: ${event.content.slice(0, 160).replaceAll("\n", " | ")}`,
            );
        },
      },
    });
  };

console.log("Connecting to Penpot…");
const penpot = await connectPenpotMcp({ url: penpotUrl });
const canvas = new PenpotUiCanvas(penpot.penpot);
const file = await canvas.checkConnection();
console.log(`  Penpot file "${file.file}"`);
const pageName = runPageName(`#${run.id.slice(0, 8)}`, projectRequest);

const workspaces = new GitWorkspaceManager({
  repoDir: join(runDir, "repo.git"),
  runBranch: run.targetRepo.runBranch,
  workspacesDir: join(runDir, "workspaces"),
});
await workspaces.startRun({
  scaffold: templateFiles(REACT_NODE),
  message: `Scaffold: ${REACT_NODE.name}`,
});

const uploaded = new Map<string, Promise<string>>();
const sandboxTesting = new SandboxTestingAgent({
  runner: new SandboxTestRunner({
    sandbox,
    snapshots: new SandboxBaseSnapshots({
      sandbox,
      store: new SqliteSnapshotStore(store),
      uploaded,
    }),
    uploaded,
  }),
});

/** The same Testing Agent, saying on the terminal what each Test Run found. */
const testing = {
  testSlice: async (input: Parameters<typeof sandboxTesting.testSlice>[0]) => {
    console.log(`  Test Run: ${input.files.length} files…`);
    const result = await sandboxTesting.testSlice(input);
    const run = result.testRun;
    const steps =
      run.status === "broken"
        ? run.problem
        : run.result.steps
            .map((step) => `${step.ok ? "ok" : "FAILED"} ${step.name}`)
            .join(", ");
    console.log(
      `  Test Run ${run.status} in ${run.evidence.durationSeconds ?? "?"}s (${run.evidence.cost ?? 0}): ${steps}`,
    );
    for (const report of result.issueReports)
      console.log(
        `    ${report.suspectedOwner ?? "unowned"}: ${report.failingTest ?? report.step} — ${report.error.slice(0, 160)}`,
      );
    return result;
  },
};

const sliceRunner = new OrchestratedSliceRunner({
  workspaces,
  testing,
  owners: new RuleOwnerResolver({
    judge: new ModelOwnerJudge({
      client,
      request: requestOptionsFor(config.roles.orchestrator),
      budget,
    }),
  }),
  tasks,
  slices,
  budget,
  codingAgent: (side, stepId) =>
    new LoopCodingAgent({
      createLoop: loopFor(
        side === "backend" ? "backendCoding" : "frontendCoding",
        30,
        stepId,
      ),
      canvas,
    }),
  checkpoint: (checkpoint) => console.log(`  checkpoint: ${checkpoint.at}`),
});

const orchestrator = new AgentRunOrchestrator({
  runs,
  documents,
  slices,
  tasks,
  escalations,
  gate,
  designPhase: new AgentDesignPhase({
    documents,
    slices,
    gate,
    systemDesign: new LoopSystemDesignAgent({
      createLoop: loopFor("systemDesign", 12),
    }),
    uiDesign: new LoopUiDesignAgent({
      canvas,
      createLoop: loopFor("uiDesign", 10),
    }),
    profile: () => REACT_NODE,
    pageName: () => pageName,
  }),
  sliceRunner: async () => sliceRunner,
  profile: () => REACT_NODE,
  capabilities: {
    backend: config.roles.backendCoding.capabilities,
    frontend: config.roles.frontendCoding.capabilities,
  },
  penpotPage: () => pageName,
});

const ask = createInterface({ input: process.stdin, output: process.stdout });

function report(): void {
  const current = runs.getRun(run.id)!;
  const built = slices
    .listSlices(run.id)
    .map((slice) => `${slice.title} (${slice.status})`)
    .join(", ");
  console.log(
    `\n[${current.status}] ${current.tokensUsed.toLocaleString()}/${tokenBudget.toLocaleString()} tokens · ${built}`,
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
    const answer = (
      await ask.question(`Approve ${document.kind}? [Y/n] `)
    ).trim();
    if (answer.toLowerCase().startsWith("n")) {
      const comments = await ask.question("  What should change? ");
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
    await ask.question(
      "  1 retry with hint · 2 edit documents · 3 skip Slice · 4 abort [1] ",
    )
  ).trim();
  if (choice === "2") {
    const kind = (await ask.question("  Which document? ")).trim();
    const comments = await ask.question("  What should change? ");
    orchestrator.resolveEscalation(run.id, {
      choice: "editDocuments",
      edits: [{ documentKind: kind as DocumentKind, comments }],
    });
  } else if (choice === "3") {
    orchestrator.resolveEscalation(run.id, { choice: "skipSlice" });
  } else if (choice === "4") {
    orchestrator.resolveEscalation(run.id, { choice: "abort" });
  } else {
    const hint = await ask.question("  Hint for the Coding Agents: ");
    orchestrator.resolveEscalation(run.id, { choice: "retryWithHint", hint });
  }
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
    // Code review and the PR Gate are T19/T20; the Slices are built.
    console.log(`Waiting for ${progress.waitingFor}: the Slices are built.`);
    break;
  }
  const commits = await workspaces.sliceCommits();
  console.log(
    `\n${commits.length} Slice Commit${commits.length === 1 ? "" : "s"} in ${join(runDir, "repo.git")} on ${run.targetRepo.runBranch}`,
  );
  console.log(
    `  See them: git --git-dir="${join(runDir, "repo.git")}" log --stat ${run.targetRepo.runBranch}`,
  );
  console.log(
    `  Try the app: git clone "${join(runDir, "repo.git")}" app && cd app && npm install && npm run dev`,
  );
} finally {
  ask.close();
  await penpot.close();
  console.log(
    `Done in ${((Date.now() - started) / 60_000).toFixed(1)} minutes, ${runs.getRun(run.id)!.tokensUsed.toLocaleString()} tokens.`,
  );
}
