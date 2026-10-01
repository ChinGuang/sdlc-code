import type {
  Checkpoint,
  NewRun,
  Run,
  RunFailure,
  RunPullRequest,
} from "../domain/entities.js";
import {
  FINISHED_RUN_STATUSES,
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
  /** Every Run, newest first, as a list of them shows it (T21). */
  listRuns: () => Run[];
  /** Runs to resume after a restart (UML diagram 9). */
  listUnfinishedRuns: () => Run[];
  /** Moves the Run through UML diagram 3; throws IllegalTransitionError otherwise. */
  applyEvent: (id: string, event: RunEvent) => Run;
  addTokensUsed: (id: string, tokens: number) => Run;
  /**
   * Gives a Run more Token Budget, so one that stopped because its budget ran
   * out can be resumed rather than started again (T18). Never less than what
   * the Run has already spent.
   */
  setTokenBudget: (id: string, tokens: number) => Run;
  setPullRequest: (id: string, pullRequest: RunPullRequest) => Run;
  /**
   * Records why the Run stopped: it failed (auto mode), or its design failed
   * and it waits for a person to ask for another try (gated, T24f). Not a
   * Checkpoint: nothing resumes from it.
   */
  recordFailure: (id: string, failure: RunFailure) => Run;
  /** Forgets why it stopped: a person asked for another try. */
  clearFailure: (id: string) => Run;
  /** What a person who aborts the Run asked for: a Draft PR of what passed, or not. */
  setOpenDraftPrOnAbort: (id: string, open: boolean) => Run;
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
  failure: string | null;
  open_draft_pr_on_abort: number | null;
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

  listRuns = (): Run[] =>
    this.#ctx.db
      // Two Runs can share a millisecond, and ids are random UUIDs: only the
      // order they were inserted in breaks the tie.
      .prepare("SELECT * FROM runs ORDER BY created_at DESC, rowid DESC")
      .all()
      .map((row) => toRun(row as RunRow));

  listUnfinishedRuns = (): Run[] =>
    this.#ctx.db
      .prepare(
        `SELECT * FROM runs WHERE status NOT IN (${FINISHED_RUN_STATUSES.map(() => "?").join(", ")})
         ORDER BY created_at, rowid`,
      )
      .all(...FINISHED_RUN_STATUSES)
      .map((row) => toRun(row as RunRow));

  applyEvent = (id: string, event: RunEvent): Run =>
    inTransaction(this.#ctx.db, () => {
      const run = this.#require(id);
      const status = nextRunStatus(run.status, event, run.mode);
      this.#ctx.db
        .prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, this.#ctx.now(), id);
      return this.#require(id);
    });

  addTokensUsed = (id: string, tokens: number): Run => {
    if (!Number.isInteger(tokens) || tokens < 0)
      throw new RangeError(
        `tokens must be a non-negative integer, got ${tokens}`,
      );
    return inTransaction(this.#ctx.db, () => {
      this.#require(id);
      this.#ctx.db
        .prepare(
          "UPDATE runs SET tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?",
        )
        .run(tokens, this.#ctx.now(), id);
      return this.#require(id);
    });
  };

  setTokenBudget = (id: string, tokens: number): Run => {
    if (!Number.isInteger(tokens) || tokens <= 0)
      throw new RangeError(`tokens must be a positive integer, got ${tokens}`);
    return inTransaction(this.#ctx.db, () => {
      const run = this.#require(id);
      if (tokens < run.tokensUsed)
        throw new RangeError(
          `Run ${id} has already spent ${run.tokensUsed} tokens; its budget cannot be ${tokens}.`,
        );
      this.#ctx.db
        .prepare(
          "UPDATE runs SET token_budget = ?, updated_at = ? WHERE id = ?",
        )
        .run(tokens, this.#ctx.now(), id);
      return this.#require(id);
    });
  };

  recordFailure = (id: string, failure: RunFailure): Run =>
    inTransaction(this.#ctx.db, () => {
      this.#require(id);
      this.#ctx.db
        .prepare("UPDATE runs SET failure = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(failure), this.#ctx.now(), id);
      return this.#require(id);
    });

  setOpenDraftPrOnAbort = (id: string, open: boolean): Run =>
    inTransaction(this.#ctx.db, () => {
      this.#require(id);
      this.#ctx.db
        .prepare(
          "UPDATE runs SET open_draft_pr_on_abort = ?, updated_at = ? WHERE id = ?",
        )
        .run(open ? 1 : 0, this.#ctx.now(), id);
      return this.#require(id);
    });

  clearFailure = (id: string): Run =>
    inTransaction(this.#ctx.db, () => {
      this.#require(id);
      this.#ctx.db
        .prepare("UPDATE runs SET failure = NULL, updated_at = ? WHERE id = ?")
        .run(this.#ctx.now(), id);
      return this.#require(id);
    });

  setPullRequest = (id: string, pullRequest: RunPullRequest): Run =>
    inTransaction(this.#ctx.db, () => {
      this.#require(id);
      this.#ctx.db
        .prepare(
          "UPDATE runs SET pr_number = ?, pr_url = ?, pr_draft = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          pullRequest.number,
          pullRequest.url,
          toFlag(pullRequest.draft),
          this.#ctx.now(),
          id,
        );
      return this.#require(id);
    });

  saveCheckpoint = (runId: string, payload: unknown): Checkpoint =>
    inTransaction(this.#ctx.db, () => {
      this.#require(runId);
      this.#ctx.db
        .prepare(
          "INSERT INTO checkpoints (id, run_id, payload, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          this.#ctx.newId(),
          runId,
          JSON.stringify(payload),
          this.#ctx.now(),
        );
      return this.latestCheckpoint(runId)!;
    });

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
    failure:
      row.failure === null ? null : (JSON.parse(row.failure) as RunFailure),
    openDraftPrOnAbort:
      row.open_draft_pr_on_abort === null
        ? null
        : row.open_draft_pr_on_abort === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
