import { REACT_NODE, type TemplateFile } from "@sdlc-code/stack-profiles";
import { describe, expect, it } from "vitest";
import {
  SqliteSnapshotStore,
  type SnapshotStore,
} from "../persistence/snapshotStore.js";
import { databaseWithRun } from "../persistence/testDatabase.js";
import {
  NODE_IMAGE_TAG,
  SandboxBaseSnapshots,
  type BaseSnapshots,
} from "./baseSnapshots.js";
import { fakeSandbox, ranOk, type FakeSandbox } from "./fakeSandbox.js";

const DAY_MS = 24 * 60 * 60_000;

function setup({
  sandbox = fakeSandbox(),
  template = [{ path: "package.json", contents: "{}" }],
  now = () => Date.parse("2026-09-20T00:00:00Z"),
}: {
  sandbox?: FakeSandbox;
  template?: TemplateFile[];
  now?: () => number;
} = {}) {
  const store: SnapshotStore = new SqliteSnapshotStore({
    ...databaseWithRun().options,
    now: () => new Date(now()).toISOString(),
  });
  // Tests depend on the interface; only this factory knows the class.
  const make = (): BaseSnapshots =>
    new SandboxBaseSnapshots({
      sandbox,
      store,
      files: () => template,
      now,
    });
  return { snapshots: make(), make, sandbox, store, template };
}

describe("SandboxBaseSnapshots", () => {
  it("builds the Snapshot from the template on Node 22, keeping the image", async () => {
    const { snapshots, sandbox } = setup({
      template: [
        { path: "package.json", contents: "{}" },
        { path: "server/app.ts", contents: "export {}" },
      ],
    });

    await expect(snapshots.snapshotImage(REACT_NODE)).resolves.toBe(
      "snapshot-img",
    );

    expect(sandbox.runs).toHaveLength(1);
    expect(sandbox.runs[0]).toMatchObject({
      image: `tag:${NODE_IMAGE_TAG}`,
      command: `cd '/app' && ${REACT_NODE.snapshotCommand}`,
      shell: true,
      disposable: false,
      files: {
        "/app/package.json": { uuid: "file-1" },
        "/app/server/app.ts": { uuid: "file-2" },
      },
    });
  });

  it("builds once, and reuses the saved Snapshot after a restart", async () => {
    const { snapshots, make, sandbox } = setup();

    await snapshots.snapshotImage(REACT_NODE);
    await snapshots.snapshotImage(REACT_NODE);
    await expect(make().snapshotImage(REACT_NODE)).resolves.toBe(
      "snapshot-img",
    );

    expect(sandbox.runs).toHaveLength(1);
  });

  it("shares one build between Test Runs that ask at the same time", async () => {
    const { snapshots, sandbox } = setup();

    const images = await Promise.all([
      snapshots.snapshotImage(REACT_NODE),
      snapshots.snapshotImage(REACT_NODE),
    ]);

    expect(images).toEqual(["snapshot-img", "snapshot-img"]);
    expect(sandbox.runs).toHaveLength(1);
  });

  it("builds a new Snapshot when the template changes", async () => {
    const template = [{ path: "package.json", contents: "{}" }];
    const { snapshots, sandbox } = setup({ template });
    await snapshots.snapshotImage(REACT_NODE);

    template[0] = { path: "package.json", contents: '{"dependencies":{}}' };
    await snapshots.snapshotImage(REACT_NODE);

    expect(sandbox.runs).toHaveLength(2);
  });

  it("rebuilds a Snapshot before the sandbox's 180-day retention drops it", async () => {
    let now = Date.parse("2026-09-20T00:00:00Z");
    const { snapshots, sandbox } = setup({ now: () => now });
    await snapshots.snapshotImage(REACT_NODE);

    now += 149 * DAY_MS;
    await snapshots.snapshotImage(REACT_NODE);
    expect(sandbox.runs).toHaveLength(1);

    now += 2 * DAY_MS;
    await snapshots.snapshotImage(REACT_NODE);
    expect(sandbox.runs).toHaveLength(2);
  });

  it("builds again after the Snapshot is discarded", async () => {
    const { snapshots, sandbox } = setup();
    await snapshots.snapshotImage(REACT_NODE);

    snapshots.discardSnapshot(REACT_NODE);
    await snapshots.snapshotImage(REACT_NODE);

    expect(sandbox.runs).toHaveLength(2);
  });

  it("imports Node 22 once when the sandbox does not have it yet", async () => {
    const sandbox = fakeSandbox({ images: [] });
    const { snapshots } = setup({ sandbox });

    await snapshots.snapshotImage(REACT_NODE);

    expect(sandbox.imports).toEqual([
      "docker://docker.io/library/node:22-slim",
    ]);
  });

  it("does not import Node 22 when the tag exists", async () => {
    const { snapshots, sandbox } = setup();

    await snapshots.snapshotImage(REACT_NODE);

    expect(sandbox.imports).toEqual([]);
  });

  // Spike T01 finding 1: the operation is SUCCESS even when the command failed.
  it("fails, saving nothing, when the install fails despite operation SUCCESS", async () => {
    const sandbox = fakeSandbox({
      onRun: () => ranOk({ exitCode: 1, stdout: "npm ERR! 404 left-pad" }),
    });
    const { snapshots } = setup({ sandbox });

    await expect(snapshots.snapshotImage(REACT_NODE)).rejects.toThrow(
      /Base Snapshot failed: exit code 1\nnpm ERR! 404 left-pad/,
    );
    // The next call tries again rather than reusing a broken Snapshot.
    await expect(snapshots.snapshotImage(REACT_NODE)).rejects.toThrow();
    expect(sandbox.runs).toHaveLength(2);
  });

  it("fails when the build saved no image", async () => {
    const sandbox = fakeSandbox({
      onRun: () => ranOk({ resultImage: null }),
    });
    const { snapshots } = setup({ sandbox });

    await expect(snapshots.snapshotImage(REACT_NODE)).rejects.toThrow(
      /saved no image/,
    );
  });
});
