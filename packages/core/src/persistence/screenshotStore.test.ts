// SPDX-License-Identifier: MPL-2.0
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileScreenshotStore,
  type ScreenshotStore,
} from "./screenshotStore.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

// Tests depend on the interface; only this factory knows the class.
function setup(): { store: ScreenshotStore; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "sdlc-screens-"));
  folders.push(dataDir);
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
      { name: "Calendar Home", order: 1, image: png("home") },
      { name: "Add Event!", order: 2, image: png("add") },
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
    store.save("run-1", 1, [{ name: "Home", order: 1, image: png("old") }]);
    store.save("run-1", 2, [{ name: "Home", order: 1, image: png("new") }]);

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

  // A crash mid-save leaves a folder with no manifest: not a version.
  it("takes the latest version written whole, even one with every export failed", () => {
    const { store, dataDir } = setup();
    store.save("run-1", 1, [{ name: "Home", order: 1, image: png("one") }]);
    mkdirSync(join(dataDir, "run-1", "screens", "v3"), { recursive: true });

    expect(store.latestVersion("run-1")).toBe(1);
    expect(store.images("run-1").get("Home")?.bytes.toString()).toBe("one");

    store.save("run-1", 2, []);
    expect(store.latestVersion("run-1")).toBe(2);
    expect(store.list("run-1")).toEqual([]);
  });

  it("replaces a version whole, leaving no screen of the old one behind", () => {
    const { store, dataDir } = setup();
    store.save("run-1", 1, [
      { name: "Home", order: 1, image: png("a") },
      { name: "Gone", order: 2, image: png("b") },
    ]);

    store.save("run-1", 1, [{ name: "Home", order: 1, image: png("c") }]);

    expect(store.list("run-1").map((shot) => shot.screen)).toEqual(["Home"]);
    expect(
      existsSync(join(dataDir, "run-1", "screens", "v1", "2-gone.png")),
    ).toBe(false);
  });

  // Served on the API's origin, so only what shows as a picture and nothing else.
  it("keeps only PNG and JPEG, and a screen keeps its place when one is missing", () => {
    const { store } = setup();

    const saved = store.save("run-1", 1, [
      { name: "Home", order: 1, image: png("a") },
      {
        name: "Evil",
        order: 2,
        image: { bytes: Buffer.from("<svg/>"), mimeType: "image/svg+xml" },
      },
      {
        name: "Photo",
        order: 3,
        image: { bytes: Buffer.from("j"), mimeType: "image/jpeg" },
      },
    ]);

    expect(
      saved.map(({ screen, order, file }) => [screen, order, file]),
    ).toEqual([
      ["Home", 1, "1-home.png"],
      ["Photo", 3, "3-photo.jpg"],
    ]);
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
