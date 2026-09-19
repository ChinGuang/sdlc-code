/** Test helper: an in-memory database with one Run, and deterministic ids and clock. */
import { openDatabase, type Database } from "./database.js";
import { SqliteRunStore } from "./runStore.js";
import type { StoreOptions } from "./storeOptions.js";

export function databaseWithRun(): {
  db: Database;
  runId: string;
  options: Required<StoreOptions>;
} {
  const db = openDatabase(":memory:");
  let id = 0;
  let tick = 0;
  const options: Required<StoreOptions> = {
    db,
    newId: () => `id-${++id}`,
    now: () => new Date(Date.UTC(2026, 8, 20, 0, 0, tick++)).toISOString(),
  };
  const { id: runId } = new SqliteRunStore(options).createRun({
    projectRequest: "todo app",
    mode: "gated",
    targetRepo: {
      owner: "o",
      name: "r",
      baseBranch: "main",
      runBranch: "sdlc/x",
    },
    stackProfile: "react-express",
    tokenBudget: 1000,
  });
  return { db, runId, options };
}
