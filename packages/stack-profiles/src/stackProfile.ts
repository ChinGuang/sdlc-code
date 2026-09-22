/**
 * A Stack Profile (CONTEXT.md): the starter template a Run builds in, how it is
 * tested, and its baseline Review Standard. One exists at launch.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_RULES, type Rule } from "./reviewStandard.js";

/** The Coding Agents of a Slice; each writes its own part of the application. */
export type CodingSide = "backend" | "frontend";

export type StackProfile = {
  id: string;
  name: string;
  /** One line for the System Design Agent's prompt. */
  summary: string;
  /** Where the template lives in this repo. */
  templateDir: string;
  /** Run in the application's directory; prints the SDLC_RESULT line. */
  testCommand: string;
  /** Run once in the application's directory to build its Base Snapshot. */
  snapshotCommand: string;
  reviewStandard: readonly Rule[];
  /**
   * What each Coding Agent may write: a folder ends with "/", anything else
   * is one file. Both may read everything; the test script is the profile's.
   */
  writablePaths: Record<CodingSide, readonly string[]>;
};

const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));

export const REACT_NODE: StackProfile = {
  id: "react-node",
  name: "React + Node",
  summary:
    "React + Vite + Tailwind frontend; Express API with Prisma (SQLite) backend; Vitest for both.",
  templateDir: join(TEMPLATES, "react-node"),
  testCommand: "node scripts/sdlcTest.mjs",
  snapshotCommand: "node scripts/sdlcTest.mjs --install-only",
  reviewStandard: BASELINE_RULES,
  writablePaths: {
    backend: ["server/", "prisma/", "package.json", ".env.example"],
    frontend: [
      "src/",
      "index.html",
      "package.json",
      "vite.config.ts",
      "tailwind.config.js",
      "postcss.config.js",
    ],
  },
};

export const STACK_PROFILES: readonly StackProfile[] = [REACT_NODE];

export function stackProfile(id: string): StackProfile {
  const profile = STACK_PROFILES.find((candidate) => candidate.id === id);
  if (!profile)
    throw new Error(
      `Unknown Stack Profile "${id}"; available: ${STACK_PROFILES.map((p) => p.id).join(", ")}.`,
    );
  return profile;
}

export type TemplateFile = { path: string; contents: string };

/** Never shipped to a generated application, and never built into a Snapshot. */
const SKIPPED = new Set(["node_modules", "dist", ".git", "prisma/dev.db"]);

/**
 * Every file of the template, with repo-relative paths using "/" so they can be
 * uploaded to a sandbox or written into a Workspace as they are.
 */
export function templateFiles(profile: StackProfile): TemplateFile[] {
  const files: TemplateFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      const path = relative(profile.templateDir, full).split(sep).join("/");
      if (SKIPPED.has(entry) || SKIPPED.has(path)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else files.push({ path, contents: readFileSync(full, "utf8") });
    }
  };
  walk(profile.templateDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
