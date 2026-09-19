import swc from "unplugin-swc";
import { defineProject } from "vitest/config";

export default defineProject({
  // Nest DI needs decorator metadata, which esbuild/oxc do not emit; SWC does.
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: { name: "server", include: ["src/**/*.test.ts"] },
});
