/**
 * One place that wires a real Run: the stores, the clients, the agents and the
 * Orchestrator (T21). The terminal script and the local server both use it, so
 * "how a Run is built" is written once and what happens is reported through one
 * event sink (runtimeEvents.ts).
 *
 * It owns many Runs, not one: the stores and the clients are shared, while a
 * Run's Workspaces, Token Budget and Penpot page are made from its record when
 * it needs them. None of those hold state of their own — the repository is on
 * disk and the budget is in the database — so nothing is cached per Run.
 *
 * The keys it reads from `env` go only to the clients that need them. Every
 * event it reports is redacted against them first, so a client that leaks a key
 * into an error message still cannot put it on a stream or into a log.
 */
import {
  connectPenpotMcp,
  NebiusSandboxClient,
  redactSecrets,
  RestGitHubClient,
  TokenFactoryChatClient,
  TokenGitPusher,
  type ChatClient,
} from "@sdlc-code/clients";
import {
  REACT_NODE,
  templateFiles,
  type StackProfile,
} from "@sdlc-code/stack-profiles";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentRole } from "../agentRoles.js";
import { ChatAgentLoop } from "../agentLoop/agentLoop.js";
import { RunTokenBudget, StepTranscript } from "../agentLoop/storeAdapters.js";
import type { AgentTool } from "../agentLoop/tools.js";
import { LoopCodeReviewAgent } from "../agents/codeReview/codeReviewAgent.js";
import { LoopCodingAgent } from "../agents/coding/codingAgent.js";
import { LoopSystemDesignAgent } from "../agents/systemDesign/systemDesignAgent.js";
import { SandboxTestingAgent } from "../agents/testing/testingAgent.js";
import { runPageName } from "../agents/uiDesign/penpotRender.js";
import { PenpotUiCanvas } from "../agents/uiDesign/uiCanvas.js";
import { LoopUiDesignAgent } from "../agents/uiDesign/uiDesignAgent.js";
import { requestOptionsFor, type AgentConfig } from "../config/agentConfig.js";
import { loadAgentConfig } from "../config/readConfigFile.js";
import {
  GitHubRunDelivery,
  type RunDelivery,
} from "../delivery/runDelivery.js";
import type { Run } from "../domain/entities.js";
import type { RunMode } from "../domain/runLifecycle.js";
import { openDatabase } from "../persistence/database.js";
import {
  SqliteDocumentStore,
  type DocumentStore,
} from "../persistence/documentStore.js";
import {
  SqliteEscalationStore,
  type EscalationStore,
} from "../persistence/escalationStore.js";
import { SqliteGateStore, type GateStore } from "../persistence/gateStore.js";
import {
  SqliteReviewStore,
  type ReviewStore,
} from "../persistence/reviewStore.js";
import { SqliteRunStore, type RunStore } from "../persistence/runStore.js";
import {
  SqliteSliceStore,
  type SliceStore,
} from "../persistence/sliceStore.js";
import { SqliteSnapshotStore } from "../persistence/snapshotStore.js";
import { SqliteTaskStore, type TaskStore } from "../persistence/taskStore.js";
import { DocumentDesignGate } from "../orchestrator/designGate.js";
import { AgentDesignPhase } from "../orchestrator/designPhase.js";
import { ModelOwnerJudge } from "../orchestrator/ownerJudge.js";
import { RuleOwnerResolver } from "../orchestrator/ownerResolution.js";
import { resumeRun, type ResumedRun } from "../orchestrator/resumeRun.js";
import {
  AgentRunOrchestrator,
  type RunOrchestrator,
} from "../orchestrator/runOrchestrator.js";
import { AgentRunReview } from "../orchestrator/runReview.js";
import { OrchestratedSliceRunner } from "../orchestrator/sliceRunner.js";
import { SandboxBaseSnapshots } from "../testRuns/baseSnapshots.js";
import { SandboxLintRunner } from "../testRuns/lintRunner.js";
import { SandboxTestRunner } from "../testRuns/testRunner.js";
import { GitWorkspaceManager } from "../workspaces/workspaceManager.js";
import { LazyUiCanvas } from "./lazyCanvas.js";
import { reportingRunStore, reportingTaskStore } from "./reportingStores.js";
import type { RuntimeEvent, RuntimeEventSink } from "./runtimeEvents.js";

/** Model turns a Step of each kind may take, from what live Runs needed. */
const TURNS = {
  // Each rejected part costs a turn; 12 ran out in Run #d4f0e8.
  systemDesign: 20,
  uiDesign: 10,
  coding: 45,
  codeReview: 12,
} as const;

/** A background tab sleeps until someone clicks it, so a Run waits for that. */
const PENPOT_RETRY_DELAYS_MS = [
  5_000, 10_000, 15_000, 30_000, 30_000, 60_000, 60_000,
];

/** A Run with nowhere to push: its Slice Commits stay in the local repository. */
export const LOCAL_OWNER = "local";

/**
 * A key the runtime needs is not set. It names the variable, never a value, so
 * an interface can show it as it is.
 */
export class MissingKeyError extends Error {
  readonly variable: string;

  constructor(variable: string, why: string) {
    super(`${variable} is not set${why ? `: ${why}` : "."}`);
    this.name = "MissingKeyError";
    this.variable = variable;
  }
}

export type NewRunRequest = {
  projectRequest: string;
  mode: RunMode;
  tokenBudget: number;
  /** "owner/name"; without one the Run keeps its Slice Commits local. */
  targetRepo?: string | null;
};

export type RunRuntimeOptions = {
  /** Where the database and every Run's repository live. */
  dataDir: string;
  /**
   * NEBIUS_API_KEY, NEBIUS_AI_PROJECT and PENPOT_MCP_URL are required, and
   * checked before anything is opened; GITHUB_TOKEN is needed for a Run with a
   * Target Repo.
   */
  env: Record<string, string | undefined>;
  events?: RuntimeEventSink;
  profile?: StackProfile;
  /** The user's own Review Standard for a Run (T19); none by default. */
  userStandards?: (run: Run) => Promise<string | null>;
  /** Tests pass their own config; otherwise it is loaded from `configPath`. */
  config?: AgentConfig;
  /** sdlc-code.config.json; per-role models come from it and from env. */
  configPath: string;
};

/** Everything an interface needs to own Runs. */
export interface RunRuntime {
  runs: RunStore;
  documents: DocumentStore;
  slices: SliceStore;
  tasks: TaskStore;
  escalations: EscalationStore;
  gates: GateStore;
  reviews: ReviewStore;
  orchestrator: RunOrchestrator;
  /** A new Run, with its repository scaffolded from the Stack Profile. */
  startRun: (request: NewRunRequest) => Promise<Run>;
  /** Makes an interrupted Run safe to continue (T18). */
  resume: (runId: string) => Promise<ResumedRun>;
  /** Where this Run's files are, and the repository its Slices commit to. */
  runDir: (runId: string) => string;
  repoDir: (runId: string) => string;
  /** Any text with this runtime's keys taken out, for errors it did not make. */
  redact: (text: string) => string;
  /** Closes the Penpot connection, if one was made, and then the database. */
  close: () => Promise<void>;
}

export function createRunRuntime(options: RunRuntimeOptions): RunRuntime {
  // Every required key first: a runtime that cannot run must not have opened
  // a database it will never close.
  const apiKey = required(options.env, "NEBIUS_API_KEY");
  const project = required(options.env, "NEBIUS_AI_PROJECT");
  const penpotUrl = required(options.env, "PENPOT_MCP_URL");
  const githubToken = options.env.GITHUB_TOKEN || null;
  // Keys only: a project id is not a secret, and a short one would mangle
  // ordinary text if it were taken out everywhere it appears.
  const secrets = [apiKey, penpotUrl, githubToken ?? ""].concat(
    userToken(penpotUrl),
  );
  const redact = (text: string) => redactSecrets(text, secrets);
  const emit = (event: RuntimeEvent) =>
    options.events?.run?.(redactEvent(event, redact));

  const profile = options.profile ?? REACT_NODE;
  const config =
    options.config ??
    loadAgentConfig({ path: options.configPath, env: options.env });

  mkdirSync(options.dataDir, { recursive: true });
  const db = openDatabase(join(options.dataDir, "sdlc-code.db"));
  const store = { db };
  const runs: RunStore = new SqliteRunStore(store);
  const documents: DocumentStore = new SqliteDocumentStore(store);
  const slices: SliceStore = new SqliteSliceStore(store);
  const tasks: TaskStore = new SqliteTaskStore(store);
  const escalations: EscalationStore = new SqliteEscalationStore(store);
  const gates: GateStore = new SqliteGateStore(store);
  const reviews: ReviewStore = new SqliteReviewStore(store);
  // The Orchestrator moves a Run many times per advance; each move is an event.
  const reportedRuns = reportingRunStore(runs, emit);
  const gate = new DocumentDesignGate({
    db,
    runs: reportedRuns,
    documents,
    gates,
  });

  const client: ChatClient = new TokenFactoryChatClient({
    apiKey,
    baseUrl: options.env.NEBIUS_BASE_URL || undefined,
  });
  const sandbox = new NebiusSandboxClient({
    token: apiKey,
    project,
    baseUrl: options.env.NEBIUS_SANDBOX_URL || undefined,
  });
  const uploaded = new Map<string, Promise<string>>();
  /**
   * One Base Snapshot per Stack Profile, shared by the Test Runs and the Lint
   * Runs: two of these would build the same snapshot twice and each keep a
   * cache the other's discard cannot clear.
   */
  const snapshots = new SandboxBaseSnapshots({
    sandbox,
    store: new SqliteSnapshotStore(store),
    uploaded,
  });

  // One browser tab serves every Run, and it is only needed once a Run draws.
  const canvas = new LazyUiCanvas({
    connect: async () => {
      const connection = await connectPenpotMcp({
        url: penpotUrl,
        retryDelaysMs: PENPOT_RETRY_DELAYS_MS,
        onWaiting: ({ attempt, delayMs, kind }) =>
          options.events?.penpot?.({
            type: "penpotWaiting",
            kind,
            attempt,
            delayMs,
          }),
      });
      const drawing = new PenpotUiCanvas(connection.penpot);
      try {
        await drawing.checkConnection();
      } catch (error) {
        // A connection that cannot draw is closed here: the canvas forgets the
        // failure and tries again, and each attempt would otherwise leak one.
        await connection.close().catch(() => {});
        throw error;
      }
      return { canvas: drawing, close: connection.close };
    },
  });

  const runDir = (runId: string) => join(options.dataDir, runId);
  const repoDir = (runId: string) => join(runDir(runId), "repo.git");
  const runOf = (runId: string): Run => {
    const found = runs.getRun(runId);
    if (!found) throw new Error(`No Run ${runId}.`);
    return found;
  };
  const pageNameFor = (run: Run) =>
    runPageName(`#${run.id.slice(0, 8)}`, run.projectRequest);
  const workspacesFor = (run: Run) =>
    new GitWorkspaceManager({
      repoDir: repoDir(run.id),
      runBranch: run.targetRepo.runBranch,
      workspacesDir: join(runDir(run.id), "workspaces"),
    });
  // Spending goes through the reporting store, so every model call is an event.
  const budgetFor = (run: Run) => new RunTokenBudget(reportedRuns, run.id);

  const loopFor =
    (run: Run, role: AgentRole, maxIterations: number, stepId?: string) =>
    (tools: AgentTool[]) => {
      const transcript = stepId ? new StepTranscript(tasks, stepId) : null;
      return new ChatAgentLoop({
        client,
        request: requestOptionsFor(config.roles[role]),
        tools,
        maxIterations,
        budget: budgetFor(run),
        transcript: {
          record: (event) => {
            transcript?.record(event);
            if (event.type === "assistant")
              emit({
                runId: run.id,
                type: "agentTurn",
                role,
                toolCalls: event.toolCalls.map((call) => call.name),
              });
            if (event.type === "toolResult" && event.problem)
              emit({
                runId: run.id,
                type: "toolFailed",
                role,
                tool: event.name,
                problem: event.content.slice(0, 300),
              });
          },
        },
      });
    };

  const testingFor = (run: Run) => {
    const agent = new SandboxTestingAgent({
      runner: new SandboxTestRunner({ sandbox, snapshots, uploaded }),
    });
    return {
      testSlice: async (input: Parameters<typeof agent.testSlice>[0]) => {
        const result = await agent.testSlice(input);
        const testRun = result.testRun;
        emit({
          runId: run.id,
          type: "testRun",
          status: testRun.status,
          summary:
            testRun.status === "broken"
              ? testRun.problem
              : testRun.result.steps
                  .map((step) => `${step.ok ? "ok" : "FAILED"} ${step.name}`)
                  .join(", "),
          durationSeconds: testRun.evidence.durationSeconds,
          cost: testRun.evidence.cost,
          issues: result.issueReports.map(
            (report) =>
              `${report.suspectedOwner ?? "unowned"}: ${report.failingTest ?? report.step} — ${report.error.slice(0, 200)}`,
          ),
        });
        return result;
      },
    };
  };

  /**
   * A Run with a Target Repo pushes its Slice Commits and opens the pull
   * request. One without keeps them in the local repository, and says so.
   * (A Run with a Target Repo and no GITHUB_TOKEN is refused at startRun.)
   */
  const deliveryFor = (run: Run): RunDelivery => {
    if (run.targetRepo.owner === LOCAL_OWNER || !githubToken)
      return {
        deliver: async () => {
          emit({
            runId: run.id,
            type: "delivery",
            status: "keptLocal",
            detail:
              "no Target Repo: the Slice Commits stay in the local repository",
          });
          return { status: "keptLocal", reason: "noTargetRepo" };
        },
      };
    const delivery = new GitHubRunDelivery({
      runs,
      slices,
      tasks,
      workspaces: workspacesFor(run),
      repoDir: repoDir(run.id),
      pusher: new TokenGitPusher({ token: githubToken }),
      github: new RestGitHubClient({ token: githubToken }),
    });
    return {
      deliver: async (runId, reason) => {
        const outcome = await delivery.deliver(runId, reason);
        emit({
          runId,
          type: "delivery",
          status: outcome.status,
          detail:
            outcome.status === "opened"
              ? outcome.pullRequest.url
              : outcome.reason,
        });
        return outcome;
      },
    };
  };

  const reviewFor = (run: Run) =>
    new AgentRunReview({
      documents,
      workspaces: workspacesFor(run),
      profile: () => profile,
      linters: new SandboxLintRunner({ sandbox, snapshots, uploaded }),
      agent: new LoopCodeReviewAgent({
        createLoop: loopFor(run, "codeReview", TURNS.codeReview),
      }),
      userStandards: options.userStandards,
    });

  const orchestrator: RunOrchestrator = new AgentRunOrchestrator({
    runs: reportedRuns,
    documents,
    slices,
    tasks,
    escalations,
    gates,
    reviews,
    gate,
    profile: () => profile,
    capabilities: {
      backend: config.roles.backendCoding.capabilities,
      frontend: config.roles.frontendCoding.capabilities,
    },
    penpotPage: (run) => pageNameFor(run),
    designPhase: (run) =>
      new AgentDesignPhase({
        documents,
        slices,
        gate,
        profile: () => profile,
        pageName: () => pageNameFor(run),
        systemDesign: new LoopSystemDesignAgent({
          createLoop: loopFor(run, "systemDesign", TURNS.systemDesign),
        }),
        uiDesign: new LoopUiDesignAgent({
          canvas,
          createLoop: loopFor(run, "uiDesign", TURNS.uiDesign),
          onExportFailed: ({ screen, reason }) =>
            emit({
              runId: run.id,
              type: "exportFailed",
              screen,
              reason: reason.slice(0, 200),
            }),
        }),
      }),
    delivery: {
      deliver: (runId, reason) =>
        deliveryFor(runOf(runId)).deliver(runId, reason),
    },
    codeReview: { reviewRun: (run) => reviewFor(run).reviewRun(run) },
    onReviewProblem: (runId, problem) =>
      emit({ runId, type: "reviewProblem", problem }),
    sliceRunner: async (run, onCheckpoint) =>
      new OrchestratedSliceRunner({
        workspaces: workspacesFor(run),
        testing: testingFor(run),
        owners: new RuleOwnerResolver({
          judge: new ModelOwnerJudge({
            client,
            request: requestOptionsFor(config.roles.orchestrator),
            budget: budgetFor(run),
          }),
        }),
        // Steps start and end in here; each is an event.
        tasks: reportingTaskStore(tasks, run.id, emit),
        slices,
        budget: budgetFor(run),
        codingAgent: (side, stepId) =>
          new LoopCodingAgent({
            createLoop: loopFor(
              run,
              side === "backend" ? "backendCoding" : "frontendCoding",
              TURNS.coding,
              stepId,
            ),
            canvas,
          }),
        checkpoint: (checkpoint) => {
          emit({
            runId: run.id,
            type: "checkpoint",
            at: checkpoint.at,
            sliceId: checkpoint.sliceId,
          });
          onCheckpoint(checkpoint);
        },
      }),
  });

  return {
    runs,
    documents,
    slices,
    tasks,
    escalations,
    gates,
    reviews,
    orchestrator,
    startRun: async (request) => {
      const [owner, name] = (request.targetRepo ?? "").split("/");
      // Found out now rather than after hours of work that cannot be pushed.
      if (owner && !githubToken)
        throw new MissingKeyError(
          "GITHUB_TOKEN",
          `a Run with a Target Repo (${request.targetRepo}) needs it to push its pull request.`,
        );
      const run = runs.createRun({
        projectRequest: request.projectRequest,
        mode: request.mode,
        targetRepo: {
          owner: owner || LOCAL_OWNER,
          name: name || "app",
          baseBranch: "main",
          runBranch: "sdlc/run",
        },
        stackProfile: profile.id,
        tokenBudget: request.tokenBudget,
      });
      await workspacesFor(run).startRun({
        scaffold: templateFiles(profile),
        message: `Scaffold: ${profile.name}`,
      });
      emit({ runId: run.id, type: "status", status: run.status });
      return run;
    },
    resume: (runId) =>
      resumeRun(runId, {
        runs,
        tasks,
        workspaces: workspacesFor(runOf(runId)),
      }),
    runDir,
    repoDir,
    redact,
    close: async () => {
      await canvas.close();
      db.close();
    },
  };
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (!value) throw new MissingKeyError(name, "");
  return value;
}

/** The token inside a Penpot MCP URL, which errors quote on their own. */
function userToken(url: string): string[] {
  try {
    const token = new URL(url).searchParams.get("userToken");
    return token ? [token] : [];
  } catch {
    return [];
  }
}

/** Every string an event carries, with the keys taken out. */
function redactEvent(
  event: RuntimeEvent,
  redact: (text: string) => string,
): RuntimeEvent {
  return Object.fromEntries(
    Object.entries(event).map(([key, value]) => [
      key,
      typeof value === "string"
        ? redact(value)
        : Array.isArray(value)
          ? value.map((item) =>
              typeof item === "string" ? redact(item) : item,
            )
          : value,
    ]),
  ) as RuntimeEvent;
}
