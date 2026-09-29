/**
 * The dashboard's two screens, picked by the URL's hash.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { parseRoute } from "./router.js";
import { DETAIL, SUMMARY, fakeApi } from "./testing/fakeApi.js";

afterEach(() => {
  window.location.hash = "";
});

describe("parseRoute", () => {
  it.each([
    ["", { page: "runs" }],
    ["#/runs", { page: "runs" }],
    ["#new-run", { page: "runs" }],
    ["#/runs/abc", { page: "run", runId: "abc" }],
    ["#/runs/a%2Fb", { page: "run", runId: "a/b" }],
  ])("reads %j", (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });
});

describe("App", () => {
  it("opens on the Runs screen", async () => {
    const { api } = fakeApi({ runs: [SUMMARY] });
    render(<App api={api} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Runs" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Todo app")).toBeInTheDocument();
    expect(screen.getByText("sdlc-code")).toBeInTheDocument();
  });

  it("moves to a Run's screen when the hash names it", async () => {
    const { api } = fakeApi({ runs: [SUMMARY], detail: DETAIL });
    render(<App api={api} />);

    act(() => {
      window.location.hash = `#/runs/${DETAIL.id}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(
      await screen.findByRole("heading", { level: 1, name: "Todo app" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Breadcrumbs" }),
    ).toHaveTextContent("Runs / #0a1b2c Todo app");
  });
});
