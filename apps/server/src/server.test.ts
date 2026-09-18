import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAppServer } from "./server.js";

const servers: Array<ReturnType<typeof createAppServer>> = [];

async function start(): Promise<string> {
  const server = createAppServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r))),
  );
});

describe("server", () => {
  it("reports health with the agent roles it knows", async () => {
    const base = await start();
    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", agentRoles: 7 });
  });

  it("returns 404 JSON for unknown routes", async () => {
    const base = await start();
    const response = await fetch(`${base}/nope`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });
});
