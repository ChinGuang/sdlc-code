import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "core",
    include: ["src/**/*.test.ts"],
    // Load mermaid with Node, not Vite: transforming its dependency tree takes ~30s.
    server: { deps: { external: [/[\\/]node_modules[\\/]/] } },
    // Mermaid costs ~1.5s on the first import in a worker, and more when every
    // project runs at once; the default 5s timeout is too tight for that.
    testTimeout: 30_000,
  },
});
