// SPDX-License-Identifier: MPL-2.0
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** The local server (apps/server); the dashboard only ever calls it as /api. */
const API = process.env.SDLC_API_URL ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
  server: {
    // Same origin in development, so the event stream needs no CORS dance.
    proxy: {
      "/api": { target: API, rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
    setupFiles: ["./src/testSetup.ts"],
  },
});
