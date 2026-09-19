import type {
  Checkpoint,
  NewRun,
  Run,
  RunPullRequest,
} from "../domain/entities.js";
import {
  nextRunStatus,
  type RunEvent,
  type RunMode,
  type RunStatus,
} from "../domain/runLifecycle.js";
import { inTransaction } from "./database.js";
import {
  fromFlag,
  NotFoundError,
  storeContext,
  toFlag,
  type StoreContext,
  type StoreOptions,
} from "./storeOptions.js";

/** Runs and their Checkpoints. */
export interface RunStore {
  createRun: (run: NewRun) => Run;
  getRun: (id: string) => Run | null;
  /** Runs to resume after a restart (UML diagram 9). */
  listUnfinishedRuns: () => Run[];
  /** Moves the Run through UML diagram 3; throws IllegalTransitionError otherwise. */
  applyEvent: (id: string, event: RunEvent) => Run;
  addTokensUsed: (id: string, tokens: number) => Run;
  setPullRequest: (id: string, pullRequest: RunPullRequest) => Run;
  saveCheckpoint: (runId: string, payload: unknown) => Checkpoint;
  latestCheckpoint: (runId: string) => Checkpoint | null;
}

type RunRow = {
  id: string;
  project_request: string;
  mode: RunMode;
  status: RunStatus;
  repo_owner: string;
  repo_name: string;
  base_branch: string;
  run_branch: string;
  stack_profile: string;
  token_budget: number;
  tokens_used: number;
  pr_number: number | null;
  pr_url: string | null;
  pr_draft: number | null;
  created_at: string;
  updated_at: string;
};

type CheckpointRow = {
  id: string;
  run_id: string;
  payload: string;
  created_at: string;
};

export class SqliteRunStore implements RunStore {
  #ctx: StoreContext;

  constructor(options: StoreOptions) {
    this.#ctx = storeContext(options);
  }

  createRun = (run: NewRun): Run => {
    const id = this.#ctx.newId();
    const now = this.#ctx.now();
    this.#ctx.db
      .prepare(
        `INSERT INTO runs (id, project_request, mode, status, repo_owner, repo_name,
           base_branch, run_branch, stack_profile, token_budget, created_at, updated_at)
         VALUES (?, ?, ?, 'designing', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        run.projectRequest,
        run.mode,
        run.targetRepo.owner,
        run.targetRepo.name,
        run.targetRepo.baseBranch,
        run.targetRepo.runBranch,
        run.stackProfile,
        run.tokenBudget,
        now,
        now,
      );
    return this.#require(id);
  };

  getRun = (id: string): Run | null => {
    const row = this.#ctx.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row as RunRow) : null;
  };

  listUnfinishedRuns = (): Run[] =>
    this.#ctx.db
      .prepare(
        "SELECT * FROM runs WHERE status NOT IN ('done', 'failed', 'aborted') ORDER BY created_at, id",
      )
      .all()
      .map((row) => toRun(row as RunRow));

  applyEvent = (id: string, event: RunEvent): Run =>
    inTransaction(this.#ctx.db, () => {
      const run = this.#require(id);
      const status = nextRunStatus(run.status, event, run.mode);
      this.#update(id, "status = ?", status);
      return this.#require(id);
    });

  addTokensUsed = (id: string, tokens: number): Run => {
    if (!Number.isInteger(tokens) || tokens < 0)
      throw new RangeError(
        `tokens must be a non-negative integer, got ${tokens}`,
      );
    this.#require(id);
    this.#update(id, "tokens_used = tokens_used + ?", tokens);
    return this.#require(id);
  };

  setPullRequest = (id: string, pullRequest: RunPullRequest): Run => {
    this.#require(id);
    this.#update(
      id,
      "pr_number = ?, pr_url = ?, pr_draft = ?",
      pullRequest.number,
      pullRequest.url,
      toFlag(pullRequest.draft),
    );
    return this.#require(id);
  };

  saveCheckpoint = (runId: string, payload: unknown): Checkpoint => {
    this.#require(runId);
    const id = this.#ctx.newId();
    this.#ctx.db
      .prepare(
        "INSERT INTO checkpoints (id, run_id, payload, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, runId, JSON.stringify(payload), this.#ctx.now());
    return this.latestCheckpoint(runId)!;
  };

  latestCheckpoint = (runId: string): Checkpoint | null => {
    const row = this.#ctx.db
      .prepare(
        "SELECT * FROM checkpoints WHERE run_id = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(runId) as CheckpointRow | undefined;
    return row
      ? {
          id: row.id,
          runId: row.run_id,
          payload: JSON.parse(row.payload),
          createdAt: row.created_at,
        }
      : null;
  };

  #require(id: string): Run {
    const run = this.getRun(id);
    if (!run) throw new NotFoundError("Run", id);
    return run;
  }

  #update(id: string, set: string, ...values: Array<string | number>): void {
    this.#ctx.db
      .prepare(`UPDATE runs SET ${set}, updated_at = ? WHERE id = ?`)
      .run(...values, this.#ctx.now(), id);
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    projectRequest: row.project_request,
    mode: row.mode,
    status: row.status,
    targetRepo: {
      owner: row.repo_owner,
      name: row.repo_name,
      baseBranch: row.base_branch,
      runBranch: row.run_branch,
    },
    stackProfile: row.stack_profile,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    pullRequest:
      row.pr_number === null || row.pr_url === null
        ? null
        : {
            number: row.pr_number,
            url: row.pr_url,
            draft: fromFlag(row.pr_draft),
          },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
