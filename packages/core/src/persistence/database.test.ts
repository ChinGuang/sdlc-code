import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inTransaction, openDatabase, schemaVersion } from "./database.js";
import { MIGRATIONS } from "./migrations.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const dbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-db-"));
  dirs.push(dir);
  return join(dir, "sdlc-code.db");
};

describe("openDatabase", () => {
  it("applies every migration to a new database", () => {
    const db = openDatabase(":memory:");

    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual([
      "checkpoints",
      "documents",
      "escalations",
      "gates",
      "runs",
      "slices",
      "step_events",
      "steps",
      "tasks",
      "verdicts",
    ]);
  });

  it("only applies new migrations when reopened", () => {
    const path = dbPath();
    const first = openDatabase(path, ["CREATE TABLE a (x)"]);
    first.prepare("INSERT INTO a VALUES (1)").run();
    first.close();

    const second = openDatabase(path, [
      "CREATE TABLE a (x)",
      "CREATE TABLE b (y)",
    ]);

    expect(schemaVersion(second)).toBe(2);
    expect(second.prepare("SELECT x FROM a").all()).toEqual([{ x: 1 }]);
    second.close();
  });

  it("rolls back a failing migration, keeping the earlier ones", () => {
    const path = dbPath();

    expect(() =>
      openDatabase(path, [
        "CREATE TABLE a (x)",
        "CREATE TABLE b (y); nonsense",
      ]),
    ).toThrow();

    const db = openDatabase(path, ["CREATE TABLE a (x)"]);
    expect(schemaVersion(db)).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").all(),
    ).toEqual([]);
    db.close();
  });

  it("refuses a database from a newer sdlc-code", () => {
    const path = dbPath();
    openDatabase(path, ["CREATE TABLE a (x)", "CREATE TABLE b (y)"]).close();

    expect(() => openDatabase(path, ["CREATE TABLE a (x)"])).toThrow(
      /newer than this sdlc-code/,
    );
  });

  it("enforces foreign keys", () => {
    const db = openDatabase(":memory:");

    expect(() =>
      db
        .prepare(
          "INSERT INTO documents (id, run_id, kind, version, status, owner_agent, content, created_at) VALUES ('d', 'missing', 'slicePlan', 1, 'drafting', 'systemDesign', '', '')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("inTransaction", () => {
  it("rolls back everything when the work throws", () => {
    const db = openDatabase(":memory:", ["CREATE TABLE a (x)"]);

    expect(() =>
      inTransaction(db, () => {
        db.prepare("INSERT INTO a VALUES (1)").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(db.prepare("SELECT * FROM a").all()).toEqual([]);
  });

  it("nests as a savepoint: committed together with the outer work", () => {
    const db = openDatabase(":memory:", ["CREATE TABLE a (x)"]);

    inTransaction(db, () => {
      db.prepare("INSERT INTO a VALUES (1)").run();
      inTransaction(db, () => db.prepare("INSERT INTO a VALUES (2)").run());
    });

    expect(db.prepare("SELECT x FROM a ORDER BY x").all()).toEqual([
      { x: 1 },
      { x: 2 },
    ]);
    expect(db.isTransaction).toBe(false);
  });

  it("rolls back only the inner work when a nested call fails and is caught", () => {
    const db = openDatabase(":memory:", ["CREATE TABLE a (x)"]);

    inTransaction(db, () => {
      db.prepare("INSERT INTO a VALUES (1)").run();
      expect(() =>
        inTransaction(db, () => {
          db.prepare("INSERT INTO a VALUES (2)").run();
          throw new Error("inner");
        }),
      ).toThrow("inner");
    });

    expect(db.prepare("SELECT x FROM a").all()).toEqual([{ x: 1 }]);
  });

  it("rolls back the inner work when the outer work fails", () => {
    const db = openDatabase(":memory:", ["CREATE TABLE a (x)"]);

    expect(() =>
      inTransaction(db, () => {
        inTransaction(db, () => db.prepare("INSERT INTO a VALUES (2)").run());
        throw new Error("outer");
      }),
    ).toThrow("outer");

    expect(db.prepare("SELECT x FROM a").all()).toEqual([]);
  });
});
