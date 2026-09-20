/**
 * Schema migrations, applied in order. Never edit a released migration: append a
 * new one. The applied count is stored in SQLite's `PRAGMA user_version`.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1: Runs, documents, gates, slices, tasks, steps, escalations, checkpoints */ `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_request TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('gated', 'auto')),
    status TEXT NOT NULL,
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    run_branch TEXT NOT NULL,
    stack_profile TEXT NOT NULL,
    token_budget INTEGER NOT NULL CHECK (token_budget > 0),
    tokens_used INTEGER NOT NULL DEFAULT 0,
    pr_number INTEGER,
    pr_url TEXT,
    pr_draft INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    owner_agent TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, kind, version)
  );

  CREATE TABLE gates (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('design', 'pr')),
    status TEXT NOT NULL CHECK (status IN ('open', 'passed')),
    opened_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX one_open_gate_per_run ON gates (run_id) WHERE status = 'open';

  CREATE TABLE verdicts (
    id TEXT PRIMARY KEY,
    gate_id TEXT NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
    -- The document version judged; NULL for a PR Gate verdict on the whole PR.
    document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'requestChanges')),
    comments TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE slices (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    is_walking_skeleton INTEGER NOT NULL,
    status TEXT NOT NULL,
    commit_sha TEXT,
    UNIQUE (run_id, position)
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    slice_id TEXT REFERENCES slices(id) ON DELETE CASCADE,
    agent_role TEXT NOT NULL,
    status TEXT NOT NULL,
    retries INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'discarded')),
    working_memory TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE UNIQUE INDEX one_running_step_per_task ON steps (task_id) WHERE status = 'running';

  CREATE TABLE step_events (
    step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (step_id, seq)
  );

  CREATE TABLE escalations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    summary TEXT NOT NULL,
    choice TEXT,
    hint TEXT,
    open_draft_pr_on_abort INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE UNIQUE INDEX one_open_escalation_per_run ON escalations (run_id) WHERE resolved_at IS NULL;

  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,

  /* 2: a closed Gate records what was decided, not just that it is over */ `
  CREATE TABLE gates_new (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('design', 'pr')),
    status TEXT NOT NULL CHECK (status IN ('open', 'passed', 'changesRequested')),
    opened_at TEXT NOT NULL
  );
  INSERT INTO gates_new SELECT id, run_id, kind, status, opened_at FROM gates;
  DROP TABLE gates;
  ALTER TABLE gates_new RENAME TO gates;
  CREATE UNIQUE INDEX one_open_gate_per_run ON gates (run_id) WHERE status = 'open';
  `,
];
