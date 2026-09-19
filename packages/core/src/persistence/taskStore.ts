import type { AgentRole } from "../agentRoles.js";
import type {
  Step,
  StepEvent,
  StepStatus,
  Task,
  TaskStatus,
} from "../domain/entities.js";
import { inTransaction } from "./database.js";
import {
  NotFoundError,
  storeContext,
  type StoreContext,
  type StoreOptions,
} from "./storeOptions.js";

export type NewTask = {
  runId: string;
  sliceId: string | null;
  agentRole: AgentRole;
};

/** Tasks, their Steps, and each Step's event rows (its Transcript). */
export interface TaskStore {
  createTask: (task: NewTask) => Task;
  setTaskStatus: (taskId: string, status: TaskStatus) => Task;
  /** Counts one more loop back after Issue Reports or blocking Findings. */
  addRetry: (taskId: string) => Task;
  listTasks: (runId: string) => Task[];
  /** Starts a Step; a Task has at most one running Step. */
  startStep: (taskId: string) => Step;
  /** Appends an event row to a running Step. */
  appendStepEvent: (
    stepId: string,
    type: string,
    payload: unknown,
  ) => StepEvent;
  completeStep: (stepId: string, workingMemory: string) => Step;
  discardStep: (stepId: string) => Step;
  /** On resume, in-flight Steps are discarded and redone (UML diagram 9). */
  discardRunningSteps: (runId: string) => Step[];
  listSteps: (taskId: string) => Step[];
  listStepEvents: (stepId: string) => StepEvent[];
}

type TaskRow = {
  id: string;
  run_id: string;
  slice_id: string | null;
  agent_role: AgentRole;
  status: TaskStatus;
  retries: number;
};

type StepRow = {
  id: string;
  task_id: string;
  status: StepStatus;
  working_memory: string | null;
  started_at: string;
  ended_at: string | null;
};

type StepEventRow = {
  step_id: string;
  seq: number;
  type: string;
  payload: string;
  at: string;
};

export class SqliteTaskStore implements TaskStore {
  #ctx: StoreContext;

  constructor(options: StoreOptions) {
    this.#ctx = storeContext(options);
  }

  createTask = ({ runId, sliceId, agentRole }: NewTask): Task => {
    const id = this.#ctx.newId();
    this.#ctx.db
      .prepare(
        "INSERT INTO tasks (id, run_id, slice_id, agent_role, status) VALUES (?, ?, ?, ?, 'pending')",
      )
      .run(id, runId, sliceId, agentRole);
    return this.#requireTask(id);
  };

  setTaskStatus = (taskId: string, status: TaskStatus): Task =>
    inTransaction(this.#ctx.db, () => {
      this.#requireTask(taskId);
      this.#ctx.db
        .prepare("UPDATE tasks SET status = ? WHERE id = ?")
        .run(status, taskId);
      return this.#requireTask(taskId);
    });

  addRetry = (taskId: string): Task =>
    inTransaction(this.#ctx.db, () => {
      this.#requireTask(taskId);
      this.#ctx.db
        .prepare("UPDATE tasks SET retries = retries + 1 WHERE id = ?")
        .run(taskId);
      return this.#requireTask(taskId);
    });

  listTasks = (runId: string): Task[] =>
    this.#ctx.db
      .prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid")
      .all(runId)
      .map((row) => toTask(row as TaskRow));

  startStep = (taskId: string): Step =>
    inTransaction(this.#ctx.db, () => {
      this.#requireTask(taskId);
      if (this.listSteps(taskId).some((step) => step.status === "running"))
        throw new Error(`Task ${taskId} already has a running Step`);
      const id = this.#ctx.newId();
      this.#ctx.db
        .prepare(
          "INSERT INTO steps (id, task_id, status, started_at) VALUES (?, ?, 'running', ?)",
        )
        .run(id, taskId, this.#ctx.now());
      return this.#requireStep(id);
    });

  appendStepEvent = (
    stepId: string,
    type: string,
    payload: unknown,
  ): StepEvent =>
    inTransaction(this.#ctx.db, () => {
      this.#requireRunning(stepId);
      const { next } = this.#ctx.db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM step_events WHERE step_id = ?",
        )
        .get(stepId) as { next: number };
      const at = this.#ctx.now();
      this.#ctx.db
        .prepare(
          "INSERT INTO step_events (step_id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(stepId, next, type, JSON.stringify(payload ?? null), at);
      return { stepId, seq: next, type, payload: payload ?? null, at };
    });

  completeStep = (stepId: string, workingMemory: string): Step =>
    inTransaction(this.#ctx.db, () =>
      this.#finish(stepId, "completed", workingMemory),
    );

  discardStep = (stepId: string): Step =>
    inTransaction(this.#ctx.db, () => this.#finish(stepId, "discarded", null));

  discardRunningSteps = (runId: string): Step[] =>
    inTransaction(this.#ctx.db, () => {
      const running = this.#ctx.db
        .prepare(
          `SELECT s.id FROM steps s JOIN tasks t ON t.id = s.task_id
           WHERE t.run_id = ? AND s.status = 'running' ORDER BY s.rowid`,
        )
        .all(runId) as Array<{ id: string }>;
      return running.map(({ id }) => this.#finish(id, "discarded", null));
    });

  listSteps = (taskId: string): Step[] =>
    this.#ctx.db
      .prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY rowid")
      .all(taskId)
      .map((row) => toStep(row as StepRow));

  listStepEvents = (stepId: string): StepEvent[] =>
    this.#ctx.db
      .prepare("SELECT * FROM step_events WHERE step_id = ? ORDER BY seq")
      .all(stepId)
      .map((row) => {
        const event = row as StepEventRow;
        return {
          stepId: event.step_id,
          seq: event.seq,
          type: event.type,
          payload: JSON.parse(event.payload),
          at: event.at,
        };
      });

  #finish(
    stepId: string,
    status: Exclude<StepStatus, "running">,
    workingMemory: string | null,
  ): Step {
    this.#requireRunning(stepId);
    this.#ctx.db
      .prepare(
        "UPDATE steps SET status = ?, working_memory = ?, ended_at = ? WHERE id = ?",
      )
      .run(status, workingMemory, this.#ctx.now(), stepId);
    return this.#requireStep(stepId);
  }

  #requireTask(id: string): Task {
    const row = this.#ctx.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id);
    if (!row) throw new NotFoundError("Task", id);
    return toTask(row as TaskRow);
  }

  #requireStep(id: string): Step {
    const row = this.#ctx.db
      .prepare("SELECT * FROM steps WHERE id = ?")
      .get(id);
    if (!row) throw new NotFoundError("Step", id);
    return toStep(row as StepRow);
  }

  #requireRunning(id: string): Step {
    const step = this.#requireStep(id);
    if (step.status !== "running")
      throw new Error(`Step ${id} is ${step.status}, not running`);
    return step;
  }
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    runId: row.run_id,
    sliceId: row.slice_id,
    agentRole: row.agent_role,
    status: row.status,
    retries: row.retries,
  };
}

function toStep(row: StepRow): Step {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    workingMemory: row.working_memory,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
