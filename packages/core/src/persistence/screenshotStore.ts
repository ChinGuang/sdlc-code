/**
 * The screens as they were drawn (T24e): the PNG the UI Design Agent exports
 * of each, kept under its Run so a person sees them at the Design Gate and a
 * resumed Run's Coding Agents see them again. Before this they lived only in
 * memory, and a restart lost them.
 *
 * They are files, not rows: images are large, and a person may open them.
 * Each design version has its own folder, so a redesign never overwrites what
 * a person already judged:
 *
 *   <dataDir>/<runId>/screens/v<version>/<n>-<screen>.png
 *   <dataDir>/<runId>/screens/v<version>/screens.json
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExportedImage } from "@sdlc-code/clients";

/** One screen's screenshot, as the manifest lists it. */
export type Screenshot = {
  /** The screen's name, as the UI Spec and the drawn boards name it. */
  screen: string;
  /** Its place among the screens, from 1; also its file's prefix. */
  order: number;
  /** The UI design document version it was drawn for. */
  version: number;
  mimeType: string;
  file: string;
};

export interface ScreenshotStore {
  /** Keeps a design version's screenshots; the screens without one are left out. */
  save: (
    runId: string,
    version: number,
    screens: ReadonlyArray<{ name: string; image: ExportedImage }>,
  ) => Screenshot[];
  /** A version's screenshots, or the latest version's; none for an old Run. */
  list: (runId: string, version?: number) => Screenshot[];
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
    screens: ReadonlyArray<{ name: string; image: ExportedImage }>,
  ): Screenshot[] => {
    const dir = this.#versionDir(runId, version);
    mkdirSync(dir, { recursive: true });
    const saved = screens.map(({ name, image }, index): Screenshot => {
      const order = index + 1;
      const file = `${order}-${slug(name)}.${extension(image.mimeType)}`;
      writeFileSync(join(dir, file), image.bytes);
      return { screen: name, order, version, mimeType: image.mimeType, file };
    });
    // Written last: a manifest names only files that are already there.
    writeFileSync(join(dir, MANIFEST), `${JSON.stringify(saved, null, 2)}\n`);
    return saved;
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

  #versionDir(runId: string, version: number): string {
    return join(this.#dataDir, runId, "screens", `v${version}`);
  }

  #latestVersion(runId: string): number | null {
    try {
      const versions = readdirSync(join(this.#dataDir, runId, "screens"))
        .map((name) => /^v(\d+)$/.exec(name)?.[1])
        .filter((found): found is string => found !== undefined)
        .map(Number);
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

function extension(mimeType: string): string {
  return mimeType === "image/svg+xml"
    ? "svg"
    : mimeType === "image/jpeg"
      ? "jpg"
      : "png";
}

function isScreenshot(value: unknown): value is Screenshot {
  if (typeof value !== "object" || value === null) return false;
  const shot = value as Record<string, unknown>;
  return (
    typeof shot.screen === "string" &&
    typeof shot.order === "number" &&
    typeof shot.version === "number" &&
    typeof shot.mimeType === "string" &&
    typeof shot.file === "string" &&
    // A manifest names files in its own folder, never a path out of it.
    /^[\w.-]+$/.test(shot.file)
  );
}
