import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

afterEach(() => vi.unstubAllGlobals());

/** How every screen is rendered in a test: at the route it lives on. */
function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("App", () => {
  it("shows the screen of the route it is asked for", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "ok", database: "up" }), {
            status: 200,
          }),
      ),
    );

    renderAt("/");

    expect(await screen.findByText("API ok, database up")).toBeInTheDocument();
  });

  it("says so when a route does not exist", () => {
    renderAt("/nowhere");

    expect(screen.getByText("This page does not exist.")).toBeInTheDocument();
  });
});
