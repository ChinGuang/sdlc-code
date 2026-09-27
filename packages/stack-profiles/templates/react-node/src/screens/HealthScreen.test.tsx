import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthScreen } from "./HealthScreen.js";

afterEach(() => vi.unstubAllGlobals());

function stubHealth(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), { status: ok ? 200 : 503 }),
    ),
  );
}

describe("HealthScreen", () => {
  it("shows the API status once it loads", async () => {
    stubHealth({ status: "ok", database: "up" });

    render(<HealthScreen />);

    expect(await screen.findByText("API ok, database up")).toBeInTheDocument();
  });

  it("shows an error when the API cannot be reached", async () => {
    stubHealth({}, false);

    render(<HealthScreen />);

    expect(
      await screen.findByText(/GET \/health failed: 503/),
    ).toBeInTheDocument();
  });
});
