import { describe, expect, it } from "vitest";
import { SqliteSnapshotStore, type SnapshotStore } from "./snapshotStore.js";
import { databaseWithRun } from "./testDatabase.js";

// Tests depend on the interface; only this factory knows the class.
function setup(): SnapshotStore {
  return new SqliteSnapshotStore(databaseWithRun().options);
}

const key = { profileId: "react-node", templateHash: "abc" };

describe("SqliteSnapshotStore", () => {
  it("finds nothing before a Snapshot is saved", () => {
    expect(setup().findSnapshot(key)).toBeNull();
  });

  it("saves and finds a Snapshot by profile and template hash", () => {
    const store = setup();

    const saved = store.saveSnapshot(key, "img-1");

    expect(saved).toMatchObject({ ...key, imageUuid: "img-1" });
    expect(store.findSnapshot(key)).toEqual(saved);
    expect(store.findSnapshot({ ...key, templateHash: "other" })).toBeNull();
  });

  it("replaces the image when the same template is rebuilt", () => {
    const store = setup();
    store.saveSnapshot(key, "img-1");

    store.saveSnapshot(key, "img-2");

    expect(store.findSnapshot(key)?.imageUuid).toBe("img-2");
  });

  it("forgets a Snapshot", () => {
    const store = setup();
    store.saveSnapshot(key, "img-1");

    store.forgetSnapshot(key);

    expect(store.findSnapshot(key)).toBeNull();
  });
});
