import { describe, expect, it } from "vitest";
import { HealthService, type HealthReporter } from "./health.service.js";

// Tests depend on the interface; only this factory knows the class.
const makeReporter = (): HealthReporter => new HealthService();

describe("HealthService", () => {
  it("reports ok and the number of agent roles", () => {
    expect(makeReporter().report()).toEqual({ status: "ok", agentRoles: 7 });
  });

  it("report works when passed as a callback", () => {
    const { report } = makeReporter();

    expect(report().status).toBe("ok");
  });
});
