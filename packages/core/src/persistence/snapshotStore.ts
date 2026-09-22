import {
  storeContext,
  type StoreContext,
  type StoreOptions,
} from "./storeOptions.js";

/**
 * A Base Snapshot (CONTEXT.md): the sandbox image with a Stack Profile's
 * template and its dependencies installed. The template hash names the exact
 * template it was built from, so a changed template gets a new Snapshot.
 */
export type BaseSnapshot = {
  profileId: string;
  templateHash: string;
  imageUuid: string;
  createdAt: string;
};

export type SnapshotKey = { profileId: string; templateHash: string };

/** Which sandbox image holds each Base Snapshot. */
export interface SnapshotStore {
  findSnapshot: (key: SnapshotKey) => BaseSnapshot | null;
  /** Records the image for a key, replacing any earlier one. */
  saveSnapshot: (key: SnapshotKey, imageUuid: string) => BaseSnapshot;
  /** Forgets a Snapshot whose image the sandbox no longer has. */
  forgetSnapshot: (key: SnapshotKey) => void;
}

type SnapshotRow = {
  profile_id: string;
  template_hash: string;
  image_uuid: string;
  created_at: string;
};

export class SqliteSnapshotStore implements SnapshotStore {
  #ctx: StoreContext;

  constructor(options: StoreOptions) {
    this.#ctx = storeContext(options);
  }

  findSnapshot = ({
    profileId,
    templateHash,
  }: SnapshotKey): BaseSnapshot | null => {
    const row = this.#ctx.db
      .prepare(
        "SELECT * FROM base_snapshots WHERE profile_id = ? AND template_hash = ?",
      )
      .get(profileId, templateHash);
    return row ? toSnapshot(row as SnapshotRow) : null;
  };

  saveSnapshot = (key: SnapshotKey, imageUuid: string): BaseSnapshot => {
    this.#ctx.db
      .prepare(
        `INSERT INTO base_snapshots (profile_id, template_hash, image_uuid, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (profile_id, template_hash)
         DO UPDATE SET image_uuid = excluded.image_uuid, created_at = excluded.created_at`,
      )
      .run(key.profileId, key.templateHash, imageUuid, this.#ctx.now());
    return this.findSnapshot(key)!;
  };

  forgetSnapshot = ({ profileId, templateHash }: SnapshotKey): void => {
    this.#ctx.db
      .prepare(
        "DELETE FROM base_snapshots WHERE profile_id = ? AND template_hash = ?",
      )
      .run(profileId, templateHash);
  };
}

function toSnapshot(row: SnapshotRow): BaseSnapshot {
  return {
    profileId: row.profile_id,
    templateHash: row.template_hash,
    imageUuid: row.image_uuid,
    createdAt: row.created_at,
  };
}
