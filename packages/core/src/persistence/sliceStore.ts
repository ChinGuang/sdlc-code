import type { Slice, SliceStatus } from "../domain/entities.js";
import { assertSliceMove } from "../domain/sliceLifecycle.js";
import { inTransaction } from "./database.js";
import {
  fromFlag,
  NotFoundError,
  storeContext,
  toFlag,
  type StoreContext,
  type StoreOptions,
} from "./storeOptions.js";

export type PlannedSlice = Pick<Slice, "title" | "isWalkingSkeleton">;

/** The Run's Slices, in Slice Plan order. */
export interface SliceStore {
  /** Saves the Slice Plan's Slices; replaces them while none has started. */
  saveSlices: (runId: string, slices: PlannedSlice[]) => Slice[];
  listSlices: (runId: string) => Slice[];
  /** Moves a Slice on; `commitSha` (the Slice Commit) is required to pass. */
  moveSlice: (sliceId: string, to: SliceStatus, commitSha?: string) => Slice;
}

type SliceRow = {
  id: string;
  run_id: string;
  position: number;
  title: string;
  is_walking_skeleton: number;
  status: SliceStatus;
  commit_sha: string | null;
};

export class SqliteSliceStore implements SliceStore {
  #ctx: StoreContext;

  constructor(options: StoreOptions) {
    this.#ctx = storeContext(options);
  }

  saveSlices = (runId: string, slices: PlannedSlice[]): Slice[] =>
    inTransaction(this.#ctx.db, () => {
      if (this.listSlices(runId).some((slice) => slice.status !== "pending"))
        throw new Error(
          `Run ${runId} has started building; its Slices can no longer be replaced`,
        );
      this.#ctx.db.prepare("DELETE FROM slices WHERE run_id = ?").run(runId);
      const insert = this.#ctx.db.prepare(
        `INSERT INTO slices (id, run_id, position, title, is_walking_skeleton, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
      );
      slices.forEach((slice, index) =>
        insert.run(
          this.#ctx.newId(),
          runId,
          index + 1,
          slice.title,
          toFlag(slice.isWalkingSkeleton),
        ),
      );
      return this.listSlices(runId);
    });

  listSlices = (runId: string): Slice[] =>
    this.#ctx.db
      .prepare("SELECT * FROM slices WHERE run_id = ? ORDER BY position")
      .all(runId)
      .map((row) => toSlice(row as SliceRow));

  moveSlice = (sliceId: string, to: SliceStatus, commitSha?: string): Slice =>
    inTransaction(this.#ctx.db, () => {
      const slice = this.#require(sliceId);
      assertSliceMove(slice.status, to);
      if ((to === "passed") !== (commitSha !== undefined))
        throw new Error(
          "A Slice Commit SHA is required to pass a Slice, and only then",
        );
      this.#ctx.db
        .prepare("UPDATE slices SET status = ?, commit_sha = ? WHERE id = ?")
        .run(to, commitSha ?? null, sliceId);
      return this.#require(sliceId);
    });

  #require(id: string): Slice {
    const row = this.#ctx.db
      .prepare("SELECT * FROM slices WHERE id = ?")
      .get(id);
    if (!row) throw new NotFoundError("Slice", id);
    return toSlice(row as SliceRow);
  }
}

function toSlice(row: SliceRow): Slice {
  return {
    id: row.id,
    runId: row.run_id,
    order: row.position,
    title: row.title,
    isWalkingSkeleton: fromFlag(row.is_walking_skeleton),
    status: row.status,
    commitSha: row.commit_sha,
  };
}
