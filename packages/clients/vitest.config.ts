import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "clients", include: ["src/**/*.test.ts"] },
});
