import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, route } from "./app.js";

describe("GET /health", () => {
  it("reports the API and its database", async () => {
    const response = await request(createApp()).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", database: "up" });
  });

  it("answers 404 for a route that does not exist", async () => {
    const response = await request(createApp()).get("/nope");

    expect(response.status).toBe(404);
  });
});

describe("a route that throws", () => {
  it("answers 500 without leaking anything about the server (SEC-03)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp((server) =>
      server.get(
        "/boom",
        route(async () => {
          throw new Error("connection string user:hunter2@db");
        }),
      ),
    );

    const response = await request(app).get("/boom");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
    expect(JSON.stringify(response.body)).not.toMatch(/hunter2|at Object|\.ts:/);
    vi.restoreAllMocks();
  });
});
