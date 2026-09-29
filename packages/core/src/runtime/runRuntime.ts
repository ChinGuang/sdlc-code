/**
 * One place that wires a real Run: the stores, the clients, the agents and the
 * Orchestrator (T21). The terminal script and the local server both use it, so
 * "how a Run is built" is written once and what happens is reported through one
 * event sink (runtimeEvents.ts).
 *
 * It owns many Runs, not one: the stores and the clients are shared, while the
 * Workspaces, the Token Budget and the Penpot page belong to a Run and are made
 * when that Run first needs them.
 *
 * Secrets are read from `env` and handed to the clients that need them. They are
 * never stored, never logged and never part of an event.
 */
import {
  connectPenpotMcp,
  NebiusSandboxClient,
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
import { ChatAgentLoop, type AgentTask } from "../agentLoop/agentLoop.js";
import type { AgentTool } from "../agentLoop/tools.js";
import { StepTranscript } from "../agentLoop/storeAdapters.js";
import { LoopCodeReviewAgent } from "../agents/codeReview/codeReviewAgent.js";
import { LoopCodingAgent } from "../agents/coding/codingAgent.js";
import { LoopSystemDesignAgent } from "../agents/systemDesign/systemDesignAgent.js";
import { SandboxTestingAgent } from "../agents/testing/testingAgent.js";
import { PenpotUiCanvas } from "../agents/uiDesign/uiCanvas.js";
import { runPageName } from "../agents/uiDesign/penpotRender.js";
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
import { SqliteDocumentStore } from "../persistence/documentStore.js";
import { SqliteEscalationStore } from "../persistence/escalationStore.js";
import { SqliteGateStore } from "../persistence/gateStore.js";
import { SqliteRunStore } from "../persistence/runStore.js";
import { SqliteSliceStore } from "../persistence/sliceStore.js";
import { SqliteSnapshotStore } from "../persistence/snapshotStore.js";
import { SqliteTaskStore } from "../persistence/taskStore.js";
import { RunTokenBudget } from "../agentLoop/storeAdapters.js";
import { AgentDesignPhase } from "../orchestrator/designPhase.js";
import { DocumentDesignGate } from "../orchestrator/designGate.js";
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
import type { WorkspaceManager } from "../workspaces/workspaceManager.js";
import { LazyUiCanvas } from "./lazyCanvas.js";
import type { RuntimeEvent, RuntimeEventSink } from "./runtimeEvents.js";

/** Model turns a Step of each kind may take, from what live Runs needed. */
const TURNS = {
  systemDesign: 12,
  uiDesign: 10,
  coding: 45,
  codeReview: 12,
} as const;

/** A background tab sleeps until someone clicks it, so a Run waits for that. */
const PENPOT_RETRY_DELAYS_MS = [
  5_000, 10_000, 15_000, 30_000, 30_000, 60_000, 60_000,
];

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
  /** Read for NEBIUS_API_KEY, NEBIUS_AI_PROJECT, PENPOT_MCP_URL, GITHUB_TOKEN. */
  env: Record<string, string | undefined>;
  events?: RuntimeEventSink;
  profile?: StackProfile;
  /** The user's own Review Standard for a Run (T19); none by default. */
  userStandards?: (run: Run) => Promise<string | null>;
  /** Tests pass their own config; otherwise it is loaded from `configPath`. */
  config?: AgentConfig;
  /** sdlc-code.config.json; per-role models come from it and from env. */
  configPath?: string;
};

/** Everything the interfaces need to own Runs. */
export interface RunRuntime {
  runs: SqliteRunStore;
  documents: SqliteDocumentStore;
  slices: SqliteSliceStore;
  tasks: SqliteTaskStore;
  escalations: SqliteEscalationStore;
  gates: SqliteGateStore;
  orchestrator: RunOrchestrator;
  /** A new Run, with its repository scaffolded from the Stack Profile. */
  startRun: (request: NewRunRequest) => Promise<Run>;
  /** Makes an interrupted Run safe to continue (T18). */
  resume: (runId: string) => Promise<ResumedRun>;
  /** Where this Run's repository and Workspaces are. */
  runDir: (runId: string) => string;
  /** Closes the database and the Penpot connection, if one was made. */
  close: () => Promise<void>;
}

export function createRunRuntime(options: RunRuntimeOptions): RunRuntime {
  const profile = options.profile ?? REACT_NODE;
  const config =
    options.config ??
    loadAgentConfig({
      path: options.configPath ?? "sdlc-code.config.json",
      env: options.env,
    });
  const emit = (event: RuntimeEvent) => options.events?.run?.(event);
  const apiKey = required(options.env, "NEBIUS_API_KEY");

  mkdirSync(options.dataDir, { recursive: true });
  const db = openDatabase(join(options.dataDir, "sdlc-code.db"));
  const store = { db };
  const runs = new SqliteRunStore(store);
  const documents = new SqliteDocumentStore(store);
  const slices = new SqliteSliceStore(store);
  const tasks = new SqliteTaskStore(store);
  const escalations = new SqliteEscalationStore(store);
  const gates = new SqliteGateStore(store);
  const gate = new DocumentDesignGate({ db, runs, documents, gates });

  const client: ChatClient = new TokenFactoryChatClient({
    apiKey,
    baseUrl: options.env.NEBIUS_BASE_URL || undefined,
  });
  const sandbox = new NebiusSandboxClient({
    token: apiKey,
    project: required(options.env, "NEBIUS_AI_PROJECT"),
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
        url: required(options.env, "PENPOT_MCP_URL"),
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
      await drawing.checkConnection();
      return { canvas: drawing, close: connection.close };
    },
  });

  const runDir = (runId: string) => join(options.dataDir, runId);
  const repoDir = (runId: string) => join(runDir(runId), "repo.git");

  /** A Run's Workspaces, made once and kept: they hold worktrees on disk. */
  const workspacesByRun = new Map<string, WorkspaceManager>();
  const workspacesFor = (run: Run): WorkspaceManager => {
    const existing = workspacesByRun.get(run.id);
    if (existing) return existing;
    const made = new GitWorkspaceManager({
      repoDir: repoDir(run.id),
      runBranch: run.targetRepo.runBranch,
      workspacesDir: join(runDir(run.id), "workspaces"),
    });
    workspacesByRun.set(run.id, made);
    return made;
  };

  /** A Run's Token Budget, which every one of its agents spends from. */
  const budgets = new Map<string, RunTokenBudget>();
  const budgetFor = (run: Run) => {
    const existing = budgets.get(run.id);
    if (existing) return existing;
    const made = new RunTokenBudget(runs, run.id);
    budgets.set(run.id, made);
    return made;
  };

  /** One agent loop: its Transcript stored under its Step, its turns reported. */
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

  /** The Testing Agent, reporting what each Test Run found. */
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
   * With a Target Repo the Run pushes its Slice Commits and opens the pull
   * request; without one there is nowhere to push, so the work stays in the
   * local repository and the event says so.
   */
  const deliveryFor = (run: Run): RunDelivery => {
    const token = options.env.GITHUB_TOKEN;
    if (run.targetRepo.owner === LOCAL_OWNER || !token)
      return {
        deliver: async () => {
          const detail =
            run.targetRepo.owner === LOCAL_OWNER
              ? "no Target Repo: the Slice Commits stay in the local repository"
              : "no GITHUB_TOKEN: nothing could be pushed";
          emit({
            runId: run.id,
            type: "delivery",
            status: "keptLocal",
            detail,
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
      pusher: new TokenGitPusher({ token }),
      github: new RestGitHubClient({ token }),
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

  const orchestrator: RunOrchestrator = new AgentRunOrchestrator({
    runs,
    documents,
    slices,
    tasks,
    escalations,
    gates,
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
    codeReview: {
      reviewRun: (run) => reviewFor(run).reviewRun(run),
    },
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
        tasks,
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

  const runOf = (runId: string): Run => {
    const found = runs.getRun(runId);
    if (!found) throw new Error(`No Run ${runId}.`);
    return found;
  };
  const pageNameFor = (run: Run) =>
    runPageName(`#${run.id.slice(0, 8)}`, run.projectRequest);

  return {
    runs,
    documents,
    slices,
    tasks,
    escalations,
    gates,
    // Every status change is an event, so a client following a Run sees it
    // without asking.
    orchestrator: {
      advance: async (runId) => {
        const progress = await orchestrator.advance(runId);
        emit({ runId, type: "status", status: runOf(runId).status });
        return progress;
      },
      decideDesign: (runId, verdicts) => {
        const decision = orchestrator.decideDesign(runId, verdicts);
        emit({ runId, type: "status", status: runOf(runId).status });
        return decision;
      },
      resolveEscalation: (runId, resolution) => {
        orchestrator.resolveEscalation(runId, resolution);
        emit({ runId, type: "status", status: runOf(runId).status });
      },
      decidePullRequest: (runId, decision) => {
        orchestrator.decidePullRequest(runId, decision);
        emit({ runId, type: "status", status: runOf(runId).status });
      },
    },
    startRun: async (request) => {
      const [owner, name] = (request.targetRepo ?? "").split("/");
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
    resume: async (runId) =>
      resumeRun(runId, {
        runs,
        tasks,
        workspaces: workspacesFor(runOf(runId)),
      }),
    runDir,
    close: async () => {
      await canvas.close();
      db.close();
    },
  };
}

/** A Run with nowhere to push: its Slice Commits stay in the local repository. */
export const LOCAL_OWNER = "local";

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/** Re-exported so callers can build a Task without importing the loop. */
export type { AgentTask };
