import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // The API runs beside the dev server; the app only ever calls /api (STRUCT-01).
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    // Screens need a DOM; the API and its tests belong in Node.
    environment: "jsdom",
    environmentMatchGlobs: [["server/**", "node"]],
    include: ["server/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/testSetup.ts"],
  },
});
