/** The local SQLite database, via better-sqlite3 (ADR 0003). */
import BetterSqlite3 from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

export type Database = BetterSqlite3.Database;

/** Opens (creating if needed) the database at `path`, or ":memory:", and migrates it. */
export function openDatabase(
  path: string,
  migrations: readonly string[] = MIGRATIONS,
): Database {
  const db = new BetterSqlite3(path);
  try {
    db.pragma("foreign_keys = ON");
    if (path !== ":memory:") db.pragma("journal_mode = WAL");
    migrate(db, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** The number of migrations applied to `db`. */
export function schemaVersion(db: Database): number {
  return db.pragma("user_version", { simple: true }) as number;
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
      db.pragma(`user_version = ${applied + index + 1}`);
    });
  });
}

/**
 * Runs `work` in a transaction: all of it is saved, or none of it. Nested calls
 * become savepoints, so callers can combine several store calls into one unit.
 */
export function inTransaction<T>(db: Database, work: () => T): T {
  return db.transaction(work).immediate();
}
