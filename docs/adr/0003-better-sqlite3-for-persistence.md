# 3. better-sqlite3 for persistence

- Status: Accepted
- Date: 2026-09-19

## Context

Runs must survive a restart (UML diagram 9), so the Orchestrator keeps Runs, documents, Gates, Slices, Tasks, Steps and Checkpoints in a local SQLite file.

We considered three Node libraries:

- **better-sqlite3**: a synchronous API, stable, widely used, and a built-in transaction helper that nests as savepoints. It is a native addon, but since v13 the package ships prebuilt binaries for Windows, macOS and Linux (x64 and arm64) and has no install script.
- **sqlite3**: also a native addon, but async with callbacks only. The stores' check-then-write sequences are simpler and race-free when synchronous.
- **`node:sqlite`** (built into Node 22.13+): synchronous with no install step, but marked experimental, it prints an `ExperimentalWarning` on every start, and its API may change. We used it briefly in T07.

## Decision

Use better-sqlite3 (v13+).

- Migrations are an append-only list of SQL scripts (`packages/core/src/persistence/migrations.ts`). The applied count is stored in `PRAGMA user_version`, and each migration runs in its own transaction.
- Foreign keys are on. File databases use WAL.
- `inTransaction` wraps `db.transaction(work).immediate()`, so nested calls become savepoints.
- Stores are classes behind interfaces (`RunStore`, `DocumentStore`, …) that apply the pure lifecycle functions inside a transaction. An illegal transition changes nothing.

## Consequences

- `pnpm install` needs no build step, no toolchain and no pnpm allow-list: the right prebuilt binary is picked at runtime.
- A platform without a bundled binary would need building from source (Python and a C++ toolchain).
- No experimental warning in `sdlccode` output.
- All access goes through the store interfaces, so swapping the library later is a local change.
