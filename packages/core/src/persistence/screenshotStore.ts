// SPDX-License-Identifier: MPL-2.0
/**
 * The screens as they were drawn (T24e): the PNG the UI Design Agent exports
 * of each, kept under its Run so a person sees them at the Design Gate and a
 * resumed Run's Coding Agents see them again. Before this they lived only in
 * memory, and a restart lost them.
 *
 * They are files, not rows: images are large, and a person may open them.
 * Each UI Spec version (what the screens are drawn from) has its own folder,
 * so a redraw from a changed UI Spec never touches what a person already
 * judged:
 *
 *   <dataDir>/<runId>/screens/v<version>/<n>-<screen>.png
 *   <dataDir>/<runId>/screens/v<version>/screens.json
 *
 * A version is written whole: into a folder of its own first, which then
 * takes the version's name. A crash mid-save leaves the last complete version
 * as it was, and drawing the same UI Spec again (an unchanged Approved
 * Document keeps its version) replaces it whole, with no screen left over.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExportedImage } from "@sdlc-code/clients";

/** One screen's screenshot, as the manifest lists it. */
export type Screenshot = {
  /** The screen's name, as the UI Spec and the drawn boards name it. */
  screen: string;
  /**
   * Its place among the screens drawn, from 1; also its file's prefix. A
   * screen whose export failed keeps its place empty rather than moving the
   * rest up.
   */
  order: number;
  /** The UI Spec version it was drawn from. */
  version: number;
  mimeType: ImageType;
  file: string;
};

/** The only images kept: what a browser shows as a picture and nothing else. */
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg" } as const;
type ImageType = keyof typeof IMAGE_TYPES;

export interface ScreenshotStore {
  /**
   * Keeps a design version's screenshots, replacing that version whole. A
   * screen whose image is not a PNG or JPEG is left out.
   */
  save: (
    runId: string,
    version: number,
    screens: ReadonlyArray<{
      name: string;
      order: number;
      image: ExportedImage;
    }>,
  ) => Screenshot[];
  /** A version's screenshots, or the latest version's; none for an old Run. */
  list: (runId: string, version?: number) => Screenshot[];
  /**
   * The latest version kept, even one whose every export failed; null for a
   * Run from before screenshots were kept.
   */
  latestVersion: (runId: string) => number | null;
  /** One screenshot's image, or null when there is no such file. */
  read: (runId: string, version: number, order: number) => ExportedImage | null;
  /** The latest version's images by screen name, as the Coding Agents take them. */
  images: (runId: string) => Map<string, ExportedImage>;
}

export type FileScreenshotStoreOptions = {
  /** Where the Runs' folders are (the runtime's dataDir). */
  dataDir: string;
};

const MANIFEST = "screens.json";

export class FileScreenshotStore implements ScreenshotStore {
  #dataDir: string;

  constructor(options: FileScreenshotStoreOptions) {
    this.#dataDir = options.dataDir;
  }

  save = (
    runId: string,
    version: number,
    screens: ReadonlyArray<{
      name: string;
      order: number;
      image: ExportedImage;
    }>,
  ): Screenshot[] => {
    const final = this.#versionDir(runId, version);
    const staging = `${final}.saving-${process.pid}-${Date.now()}`;
    mkdirSync(staging, { recursive: true });
    try {
      const saved = screens.flatMap(({ name, order, image }): Screenshot[] => {
        if (!isImageType(image.mimeType)) return [];
        const file = `${order}-${slug(name)}.${IMAGE_TYPES[image.mimeType]}`;
        writeFileSync(join(staging, file), image.bytes);
        return [
          { screen: name, order, version, mimeType: image.mimeType, file },
        ];
      });
      // Written last: a manifest names only files that are already there.
      writeFileSync(
        join(staging, MANIFEST),
        `${JSON.stringify(saved, null, 2)}\n`,
      );
      rmSync(final, { recursive: true, force: true });
      renameSync(staging, final);
      return saved;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  };

  list = (runId: string, version?: number): Screenshot[] => {
    const chosen = version ?? this.#latestVersion(runId);
    if (chosen === null) return [];
    try {
      const parsed = JSON.parse(
        readFileSync(join(this.#versionDir(runId, chosen), MANIFEST), "utf8"),
      ) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isScreenshot) : [];
    } catch {
      return [];
    }
  };

  read = (
    runId: string,
    version: number,
    order: number,
  ): ExportedImage | null => {
    const shot = this.list(runId, version).find((one) => one.order === order);
    if (!shot) return null;
    try {
      return {
        bytes: readFileSync(join(this.#versionDir(runId, version), shot.file)),
        mimeType: shot.mimeType,
      };
    } catch {
      return null;
    }
  };

  images = (runId: string): Map<string, ExportedImage> => {
    const latest = this.#latestVersion(runId);
    if (latest === null) return new Map();
    return new Map(
      this.list(runId, latest).flatMap((shot) => {
        const image = this.read(runId, latest, shot.order);
        return image ? [[shot.screen, image] as const] : [];
      }),
    );
  };

  latestVersion = (runId: string): number | null => this.#latestVersion(runId);

  #versionDir(runId: string, version: number): string {
    return join(this.#dataDir, runId, "screens", `v${version}`);
  }

  /** The newest version that was written whole, which is one with a manifest. */
  #latestVersion(runId: string): number | null {
    const screens = join(this.#dataDir, runId, "screens");
    try {
      const versions = readdirSync(screens)
        .map((name) => /^v(\d+)$/.exec(name)?.[1])
        .filter((found): found is string => found !== undefined)
        .map(Number)
        .filter((version) =>
          existsSync(join(screens, `v${version}`, MANIFEST)),
        );
      return versions.length > 0 ? Math.max(...versions) : null;
    } catch {
      return null;
    }
  }
}

/** A file name from a screen name: letters, digits and dashes only. */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "screen"
  );
}

function isImageType(mimeType: string): mimeType is ImageType {
  return Object.hasOwn(IMAGE_TYPES, mimeType);
}

function isScreenshot(value: unknown): value is Screenshot {
  if (typeof value !== "object" || value === null) return false;
  const shot = value as Record<string, unknown>;
  return (
    typeof shot.screen === "string" &&
    typeof shot.order === "number" &&
    typeof shot.version === "number" &&
    typeof shot.mimeType === "string" &&
    isImageType(shot.mimeType) &&
    typeof shot.file === "string" &&
    // A manifest names files in its own folder, never a path out of it.
    /^[\w.-]+$/.test(shot.file)
  );
}
