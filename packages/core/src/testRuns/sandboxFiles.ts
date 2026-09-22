/**
 * Getting an application's files into the sandbox: which files may go, where
 * they land, and uploading each distinct content once.
 */
import { createHash } from "node:crypto";
import type { FileRef, SandboxClient } from "@sdlc-code/clients";
import type { TemplateFile } from "@sdlc-code/stack-profiles";

/** Where the application lives inside the sandbox. */
export const SANDBOX_APP_DIR = "/app";

export const sha256 = (contents: string): string =>
  createHash("sha256").update(contents).digest("hex");

/**
 * Secrets never enter the sandbox (the sandbox runs generated code): a `.env`
 * file is withheld, whatever the Workspace holds. The example file is not a
 * secret and ships with the template.
 */
export function isSecretFile(path: string): boolean {
  // Either separator, any case: Windows reads ".ENV" and "a\.env" as ".env".
  const name = (path.split(/[/\\]/).at(-1) ?? path).toLowerCase();
  return (
    (name === ".env" || name.startsWith(".env.")) && name !== ".env.example"
  );
}

/** A path must stay inside the application, written the way the template writes it. */
export function assertAppPath(path: string): void {
  const parts = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error(
      `Refusing file path "${path}": it must be relative, use "/", and stay inside the application.`,
    );
}

/** Quotes one word for `sh`. */
export const shellQuote = (word: string): string =>
  `'${word.replaceAll("'", `'"'"'`)}'`;

/**
 * Names the exact inputs of a Base Snapshot, so a change to the template, the
 * command that builds it, or the image it starts from builds a new one.
 */
export function snapshotHash(
  files: readonly TemplateFile[],
  snapshotCommand: string,
  baseImage: string,
): string {
  const hash = createHash("sha256").update(
    `image\0${baseImage}\0command\0${snapshotCommand}\0`,
  );
  for (const file of [...files].sort(byPath))
    hash.update(`file\0${file.path}\0${sha256(file.contents)}\0`);
  return hash.digest("hex");
}

/** By code point: the hash must not depend on the machine's locale. */
const byPath = (a: TemplateFile, b: TemplateFile): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const UPLOAD_CONCURRENCY = 8;

/** Sandbox file ids by content sha256; an upload in flight is shared, not repeated. */
export type UploadCache = Map<string, Promise<string>>;

/**
 * Uploads files in parallel and maps each to its place under /app. Content
 * already uploaded (same sha256, recorded in `uploaded`) is not sent again.
 * A secret file is never uploaded, whoever asks.
 */
export async function uploadFiles(
  sandbox: SandboxClient,
  files: readonly TemplateFile[],
  uploaded: UploadCache,
): Promise<Record<string, FileRef>> {
  const refs: Record<string, FileRef> = {};
  const queue = files.filter((file) => !isSecretFile(file.path));
  for (const file of queue) assertAppPath(file.path);
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const digest = sha256(file.contents);
      let uuid = uploaded.get(digest);
      if (!uuid) {
        uuid = sandbox.uploadFile(file.contents).then((stored) => stored.uuid);
        uploaded.set(digest, uuid);
        // A failed upload must not be reused by the next Test Run.
        uuid.catch(() => uploaded.delete(digest));
      }
      refs[`${SANDBOX_APP_DIR}/${file.path}`] = { uuid: await uuid };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker),
  );
  return refs;
}
