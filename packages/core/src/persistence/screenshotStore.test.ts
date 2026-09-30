import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileScreenshotStore,
  type ScreenshotStore,
} from "./screenshotStore.js";

// Tests depend on the interface; only this factory knows the class.
function setup(): { store: ScreenshotStore; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "sdlc-screens-"));
  return { store: new FileScreenshotStore({ dataDir }), dataDir };
}

const png = (text: string) => ({
  bytes: Buffer.from(text),
  mimeType: "image/png",
});

describe("FileScreenshotStore", () => {
  it("keeps each screen's image, in order, under the Run and the version", () => {
    const { store } = setup();

    const saved = store.save("run-1", 2, [
      { name: "Calendar Home", image: png("home") },
      { name: "Add Event!", image: png("add") },
    ]);

    expect(saved).toEqual([
      {
        screen: "Calendar Home",
        order: 1,
        version: 2,
        mimeType: "image/png",
        file: "1-calendar-home.png",
      },
      {
        screen: "Add Event!",
        order: 2,
        version: 2,
        mimeType: "image/png",
        file: "2-add-event.png",
      },
    ]);
    expect(store.list("run-1")).toEqual(saved);
    expect(store.read("run-1", 2, 2)?.bytes.toString()).toBe("add");
  });

  // A redesign never overwrites what a person already judged.
  it("keeps every version, and lists the latest unless asked", () => {
    const { store } = setup();
    store.save("run-1", 1, [{ name: "Home", image: png("old") }]);
    store.save("run-1", 2, [{ name: "Home", image: png("new") }]);

    expect(store.read("run-1", 1, 1)?.bytes.toString()).toBe("old");
    expect(store.list("run-1").map((shot) => shot.version)).toEqual([2]);
    expect(store.list("run-1", 1).map((shot) => shot.version)).toEqual([1]);
    expect(store.images("run-1").get("Home")?.bytes.toString()).toBe("new");
  });

  // A Run from before T24e has no screenshots, and says so by having none.
  it("has none for a Run that never kept any", () => {
    const { store } = setup();

    expect(store.list("old-run")).toEqual([]);
    expect(store.read("old-run", 1, 1)).toBeNull();
    expect(store.images("old-run").size).toBe(0);
  });

  it("never reads a file outside its own folder, whatever a manifest says", () => {
    const { store, dataDir } = setup();
    const dir = join(dataDir, "run-1", "screens", "v1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "screens.json"),
      JSON.stringify([
        {
          screen: "x",
          order: 1,
          version: 1,
          mimeType: "image/png",
          file: "../../../secret.png",
        },
      ]),
    );

    expect(store.list("run-1")).toEqual([]);
    expect(store.read("run-1", 1, 1)).toBeNull();
  });
});
