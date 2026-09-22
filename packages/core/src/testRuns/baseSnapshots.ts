/**
 * Base Snapshots (CONTEXT.md): each Stack Profile's template, with its
 * dependencies installed, saved once as a sandbox image. Every Test Run starts
 * from it, so a run pays only for the Slice's own changes.
 */
import {
  commandSucceeded,
  type RunResult,
  type SandboxClient,
} from "@sdlc-code/clients";
import {
  templateFiles,
  type StackProfile,
  type TemplateFile,
} from "@sdlc-code/stack-profiles";
import type { SnapshotStore } from "../persistence/snapshotStore.js";
import {
  SANDBOX_APP_DIR,
  shellQuote,
  snapshotHash,
  uploadFiles,
  type UploadCache,
} from "./sandboxFiles.js";

/** Node 22 is not in the public catalogue; it is imported once under this tag. */
export const NODE_IMAGE_TAG = "sdlc-code/node:22-slim";
const NODE_IMAGE_SOURCE = "docker://docker.io/library/node:22-slim";

/** Installing the template's dependencies is the slow part (spike T01). */
const BUILD_TIMEOUT_SECONDS = 900;
const IMPORT_TIMEOUT_MS = 15 * 60_000;
/**
 * The sandbox keeps images for 180 days (Beta); rebuilding before then is
 * cheaper than a Test Run failing on a missing image.
 */
const MAX_SNAPSHOT_AGE_DAYS = 150;
const DAY_MS = 24 * 60 * 60_000;

export type BaseSnapshotsOptions = {
  sandbox: SandboxClient;
  store: SnapshotStore;
  /** Content already uploaded, by sha256; shared with the Test Runner. */
  uploaded?: UploadCache;
  /** Defaults to the template in this repo. */
  files?: (profile: StackProfile) => TemplateFile[];
  now?: () => number;
};

/** The sandbox image each Stack Profile's Test Runs start from. */
export interface BaseSnapshots {
  /** The profile's Base Snapshot image, built the first time it is needed. */
  snapshotImage: (profile: StackProfile) => Promise<string>;
  /** Forgets the Snapshot, so the next call builds it again. */
  discardSnapshot: (profile: StackProfile) => void;
}

export class SandboxBaseSnapshots implements BaseSnapshots {
  #sandbox: SandboxClient;
  #store: SnapshotStore;
  #uploaded: UploadCache;
  #files: (profile: StackProfile) => TemplateFile[];
  #now: () => number;
  /** One build per template at a time, however many Test Runs wait for it. */
  #building = new Map<string, Promise<string>>();

  constructor(options: BaseSnapshotsOptions) {
    this.#sandbox = options.sandbox;
    this.#store = options.store;
    this.#uploaded = options.uploaded ?? new Map();
    this.#files = options.files ?? templateFiles;
    this.#now = options.now ?? Date.now;
  }

  snapshotImage = (profile: StackProfile): Promise<string> => {
    const files = this.#files(profile);
    const key = {
      profileId: profile.id,
      templateHash: snapshotHash(
        files,
        profile.snapshotCommand,
        NODE_IMAGE_TAG,
      ),
    };
    const saved = this.#store.findSnapshot(key);
    if (
      saved &&
      this.#now() - Date.parse(saved.createdAt) < MAX_SNAPSHOT_AGE_DAYS * DAY_MS
    )
      return Promise.resolve(saved.imageUuid);

    const building = `${key.profileId}\0${key.templateHash}`;
    let build = this.#building.get(building);
    if (!build) {
      build = this.#build(profile, files)
        .then((image) => this.#store.saveSnapshot(key, image).imageUuid)
        .finally(() => this.#building.delete(building));
      this.#building.set(building, build);
    }
    return build;
  };

  discardSnapshot = (profile: StackProfile): void => {
    this.#store.forgetSnapshot({
      profileId: profile.id,
      templateHash: snapshotHash(
        this.#files(profile),
        profile.snapshotCommand,
        NODE_IMAGE_TAG,
      ),
    });
  };

  async #build(profile: StackProfile, files: TemplateFile[]): Promise<string> {
    await this.#ensureNodeImage();
    const result = await this.#sandbox.run(
      {
        image: `tag:${NODE_IMAGE_TAG}`,
        command: `cd ${shellQuote(SANDBOX_APP_DIR)} && ${profile.snapshotCommand}`,
        shell: true,
        files: await uploadFiles(this.#sandbox, files, this.#uploaded),
        timeout: BUILD_TIMEOUT_SECONDS,
        // Not disposable: the run's resulting image is the Snapshot.
        disposable: false,
      },
      { pollMs: 1000, timeoutMs: (BUILD_TIMEOUT_SECONDS + 120) * 1000 },
    );
    if (!commandSucceeded(result))
      throw new Error(
        `Building the ${profile.name} Base Snapshot failed: ${describeRun(result)}`,
      );
    if (!result.resultImage)
      throw new Error(
        `Building the ${profile.name} Base Snapshot saved no image (operation ${result.operationId}).`,
      );
    return result.resultImage;
  }

  async #ensureNodeImage(): Promise<void> {
    const { images } = await this.#sandbox.listImages(NODE_IMAGE_TAG);
    if (images.some((image) => image.tag === NODE_IMAGE_TAG)) return;
    const operation = await this.#sandbox.waitForOperation(
      await this.#sandbox.importImage(NODE_IMAGE_SOURCE, NODE_IMAGE_TAG),
      { timeoutMs: IMPORT_TIMEOUT_MS },
    );
    if (operation.status !== "SUCCESS")
      throw new Error(
        `Importing ${NODE_IMAGE_SOURCE} failed: ${operation.status} ${operation.error ?? ""}`.trim(),
      );
  }
}

/** How a sandbox command ended, with the end of its output. */
export function describeRun(result: RunResult): string {
  const reason = result.timedOut
    ? "timed out"
    : result.status !== "SUCCESS"
      ? `the sandbox reported ${result.status}${result.error ? ` (${result.error})` : ""}`
      : result.exitCode !== 0
        ? `exit code ${result.exitCode}`
        : "the command succeeded";
  const tail = `${result.stdout}${result.stderr}`.trim().slice(-2000);
  return tail ? `${reason}\n${tail}` : reason;
}
