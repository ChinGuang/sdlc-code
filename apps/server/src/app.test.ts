import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AppModule } from "./app.module.js";
import {
  HEALTH_REPORTER,
  type HealthReporter,
} from "./health/health.service.js";

const apps: INestApplication[] = [];

async function start(reporter?: HealthReporter): Promise<string> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (reporter)
    builder = builder.overrideProvider(HEALTH_REPORTER).useValue(reporter);
  const app = (await builder.compile()).createNestApplication({
    logger: false,
  });
  apps.push(app);
  await app.listen(0, "127.0.0.1");
  return app.getUrl();
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("server", () => {
  it("reports health with the agent roles it knows", async () => {
    const base = await start();
    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", agentRoles: 7 });
  });

  it("serves whatever HealthReporter is bound, so the controller depends on the interface", async () => {
    const base = await start({
      report: () => ({ status: "ok", agentRoles: 99 }),
    });
    const response = await fetch(`${base}/health`);

    expect(await response.json()).toEqual({ status: "ok", agentRoles: 99 });
  });

  it("returns 404 JSON for unknown routes", async () => {
    const base = await start();
    const response = await fetch(`${base}/nope`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ statusCode: 404 });
  });
});
