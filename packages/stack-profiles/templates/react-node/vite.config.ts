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
    // Screens need a DOM and the React plugin; the API and its tests belong in
    // Node. Two projects rather than one environment with exceptions, which is
    // what Vitest asks for now.
    projects: [
      {
        extends: true,
        test: {
          name: "screens",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/testSetup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "api",
          environment: "node",
          include: ["server/**/*.test.ts"],
        },
      },
    ],
  },
});
