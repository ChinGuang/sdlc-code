/**
 * The local SQLite database, via Node's built-in `node:sqlite` (ADR 0003):
 * no native addon to build, which pnpm blocks by default.
 */
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.js";

export type Database = DatabaseSync;

/** Opens (creating if needed) the database at `path`, or ":memory:", and migrates it. */
export function openDatabase(
  path: string,
  migrations: readonly string[] = MIGRATIONS,
): Database {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    migrate(db, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The number of migrations applied to `db`. */
export function schemaVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  return row.user_version;
}

function migrate(db: Database, migrations: readonly string[]): void {
  const applied = schemaVersion(db);
  if (applied > migrations.length)
    throw new Error(
      `Database schema version ${applied} is newer than this sdlc-code (${migrations.length}); upgrade sdlc-code.`,
    );
  migrations.slice(applied).forEach((sql, index) => {
    inTransaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${applied + index + 1}`);
    });
  });
}

/** Runs `work` in a transaction: all of it is saved, or none of it. */
export function inTransaction<T>(db: Database, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
