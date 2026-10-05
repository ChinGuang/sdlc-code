// SPDX-License-Identifier: MPL-2.0
/**
 * The dashboard's two screens, picked by the URL's hash.
 */
import { act, render, screen, within } from "@testing-library/react";
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
    ["#/runs/abc", { page: "run", runId: "abc", tab: "overview" }],
    ["#/runs/a%2Fb", { page: "run", runId: "a/b", tab: "overview" }],
    [
      "#/runs/abc/design-gate",
      { page: "run", runId: "abc", tab: "designGate" },
    ],
    ["#/runs/abc/review", { page: "run", runId: "abc", tab: "review" }],
    ["#/runs/abc/nonsense", { page: "run", runId: "abc", tab: "overview" }],
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
    expect(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole(
        "link",
        {
          name: "Runs",
        },
      ),
    ).toHaveAttribute("aria-current", "page");
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
    expect(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole(
        "link",
        {
          name: "Runs",
        },
      ),
    ).not.toHaveAttribute("aria-current");
  });

  // Nothing of one Run may show on another's page.
  it("starts afresh when the hash moves from one Run to another", async () => {
    const { api, push } = fakeApi({ runs: [SUMMARY], detail: DETAIL });
    const other = { ...DETAIL, id: "ffffff00-other", projectRequest: "Blog" };
    const getRun = api.getRun;
    api.getRun = async (runId) => (runId === other.id ? other : getRun(runId));
    render(<App api={api} />);
    const go = (runId: string) =>
      act(() => {
        window.location.hash = `#/runs/${runId}`;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });

    go(DETAIL.id);
    await screen.findByRole("heading", { level: 1, name: "Todo app" });
    act(() => void push({ type: "problem", problem: "only on the first Run" }));
    go(other.id);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Blog" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("only on the first Run")).toBeNull();
  });
});
