# 3. Node's built-in `node:sqlite` for persistence

- Status: Accepted
- Date: 2026-09-19
- Supersedes: "better-sqlite3" in docs/PLAN.md T07

## Context

Runs must survive a restart (UML diagram 9), so the Orchestrator keeps Runs, documents, Gates, Slices, Tasks, Steps and Checkpoints in a local SQLite file. The plan named `better-sqlite3`. That is a native addon: it needs an install script, to download or compile a binary. pnpm 10 blocks dependency install scripts by default, so every developer and CI job would have to approve and build it, and a missing toolchain breaks `pnpm install` on Windows.

Node 22.13+ ships `node:sqlite` (`DatabaseSync`), a synchronous SQLite API with prepared statements, and it needs no install step.

## Decision

Use `node:sqlite`. Raise `engines.node` to `>=22.13`, the first 22.x release where it needs no flag.

- Migrations are an append-only list of SQL scripts (`packages/core/src/persistence/migrations.ts`). The applied count is stored in `PRAGMA user_version`, and each migration runs in its own transaction.
- Foreign keys are on. File databases use WAL.
- Stores are classes behind interfaces (`RunStore`, `DocumentStore`, …) that apply the pure lifecycle functions inside a transaction. An illegal transition changes nothing.

## Consequences

- No native dependency, and `pnpm install` stays script-free.
- `node:sqlite` is still marked experimental and prints an `ExperimentalWarning` once per process. Its API could change in a later Node major. Keeping it behind the store interfaces makes a later swap (e.g. to `better-sqlite3`) a local change.
- `DatabaseSync` has no transaction helper, so `inTransaction` wraps `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` itself.
