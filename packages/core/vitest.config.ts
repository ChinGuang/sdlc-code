import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "core",
    include: ["src/**/*.test.ts"],
    // Load mermaid with Node, not Vite: transforming its dependency tree takes ~30s.
    server: { deps: { external: [/[\\/]node_modules[\\/]/] } },
  },
});
