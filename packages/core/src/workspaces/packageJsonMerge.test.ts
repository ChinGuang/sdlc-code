import { describe, expect, it } from "vitest";
import { mergePackageJson } from "./packageJsonMerge.js";

const manifest = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const base = {
  name: "app",
  scripts: { dev: "vite", test: "vitest run" },
  dependencies: { express: "^4.21.2", react: "^19.0.0" },
  devDependencies: { vitest: "^2.1.8" },
};

describe("mergePackageJson", () => {
  it("keeps what each side added, with dependencies sorted", () => {
    const ours = {
      ...base,
      dependencies: { ...base.dependencies, zod: "^3.24.1" },
    };
    const theirs = {
      ...base,
      dependencies: { ...base.dependencies, "react-router-dom": "^7.0.0" },
      devDependencies: {
        ...base.devDependencies,
        "@testing-library/user-event": "^14.5.0",
      },
    };

    const merged = mergePackageJson(
      manifest(base),
      manifest(ours),
      manifest(theirs),
    );

    expect(JSON.parse(merged!)).toEqual({
      ...base,
      dependencies: {
        express: "^4.21.2",
        react: "^19.0.0",
        "react-router-dom": "^7.0.0",
        zod: "^3.24.1",
      },
      devDependencies: {
        "@testing-library/user-event": "^14.5.0",
        vitest: "^2.1.8",
      },
    });
    expect(Object.keys(JSON.parse(merged!).dependencies)).toEqual([
      "express",
      "react",
      "react-router-dom",
      "zod",
    ]);
    expect(merged!.endsWith("}\n")).toBe(true);
  });

  it("keeps scripts in the order people wrote them", () => {
    const ours = {
      ...base,
      scripts: { ...base.scripts, "db:seed": "tsx seed.ts" },
    };
    const theirs = {
      ...base,
      scripts: { ...base.scripts, build: "vite build" },
    };

    const merged = JSON.parse(
      mergePackageJson(manifest(base), manifest(ours), manifest(theirs))!,
    );

    expect(Object.keys(merged.scripts)).toEqual([
      "dev",
      "test",
      "db:seed",
      "build",
    ]);
  });

  it("accepts the same addition from both sides", () => {
    const both = {
      ...base,
      dependencies: { ...base.dependencies, zod: "^3.24.1" },
    };

    expect(
      JSON.parse(
        mergePackageJson(manifest(base), manifest(both), manifest(both))!,
      ),
    ).toEqual(both);
  });

  it("keeps a removal by one side the other did not touch", () => {
    const ours = { ...base, devDependencies: {} };

    expect(
      JSON.parse(
        mergePackageJson(manifest(base), manifest(ours), manifest(base))!,
      ).devDependencies,
    ).toEqual({});
  });

  it("is a real conflict when both change the same key differently", () => {
    const ours = {
      ...base,
      dependencies: { ...base.dependencies, react: "^19.1.0" },
    };
    const theirs = {
      ...base,
      dependencies: { ...base.dependencies, react: "^18.3.1" },
    };

    expect(
      mergePackageJson(manifest(base), manifest(ours), manifest(theirs)),
    ).toBeNull();
  });

  it("is a real conflict when a file is not a JSON object", () => {
    expect(
      mergePackageJson(manifest(base), "{ broken", manifest(base)),
    ).toBeNull();
    expect(mergePackageJson(manifest(base), "[]", manifest(base))).toBeNull();
  });
});
