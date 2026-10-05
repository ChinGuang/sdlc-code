// SPDX-License-Identifier: MPL-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "apps/*",
      { test: { name: "standards", include: ["tests/**/*.test.ts"] } },
    ],
  },
});
