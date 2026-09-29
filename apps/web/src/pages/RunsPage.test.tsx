/**
 * Board 01: the runs table as the server lists Runs, and the New run form,
 * which starts a Run and opens it, or shows why the server refused.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RunsApi } from "../api/client.js";
import { SUMMARY, fakeApi } from "../testing/fakeApi.js";
import { RunsPage } from "./RunsPage.js";

const NOW = () => new Date("2026-09-29T10:00:00.000Z");

afterEach(() => {
  window.location.hash = "";
});

describe("RunsPage: Recent runs", () => {
  it("lists each Run with its progress, spend, status and age", async () => {
    const { api } = fakeApi({ runs: [SUMMARY] });
    render(<RunsPage api={api} search="" now={NOW} />);

    const row = (await screen.findByText("Todo app")).closest("tr")!;
    expect(within(row).getByText("#0a1b2c")).toBeInTheDocument();
    expect(within(row).getByText("Slices")).toBeInTheDocument();
    expect(within(row).getByText("612k / 2.0M")).toBeInTheDocument();
    expect(within(row).getByText("Coding")).toBeInTheDocument();
    expect(within(row).getByText("2m ago")).toBeInTheDocument();
  });

  it("opens a Run when its row is clicked", async () => {
    const { api } = fakeApi({ runs: [SUMMARY] });
    render(<RunsPage api={api} search="" now={NOW} />);

    fireEvent.click(await screen.findByText("Todo app"));

    expect(window.location.hash).toBe(`#/runs/${SUMMARY.id}`);
  });

  it("keeps only the Runs a search matches", async () => {
    const other = { ...SUMMARY, id: "ffffff00", projectRequest: "Blog" };
    const { api } = fakeApi({ runs: [SUMMARY, other] });
    render(<RunsPage api={api} search="blog" now={NOW} />);

    expect(await screen.findByText("Blog")).toBeInTheDocument();
    expect(screen.queryByText("Todo app")).toBeNull();
  });

  it("says there are no Runs yet", async () => {
    const { api } = fakeApi({ runs: [] });
    render(<RunsPage api={api} search="" now={NOW} />);

    expect(
      await screen.findByText("No Runs yet. Start one above."),
    ).toBeInTheDocument();
  });
});

describe("RunsPage: New run", () => {
  function fill() {
    fireEvent.change(screen.getByLabelText(/Project request/), {
      target: { value: "  Todo app  " },
    });
    fireEvent.change(screen.getByLabelText("Target repo"), {
      target: { value: "ChinGuang/todo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Auto · no gates" }));
    fireEvent.change(screen.getByLabelText("Token budget"), {
      target: { value: "1,500,000" },
    });
  }

  it("starts a Run with what was filled in, and opens it", async () => {
    const startRun = vi.fn<RunsApi["startRun"]>(async () => SUMMARY);
    const { api } = fakeApi({ runs: [], startRun });
    render(<RunsPage api={api} search="" now={NOW} />);

    fill();
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await vi.waitFor(() =>
      expect(window.location.hash).toBe(`#/runs/${SUMMARY.id}`),
    );
    expect(startRun).toHaveBeenCalledWith({
      projectRequest: "Todo app",
      mode: "auto",
      tokenBudget: 1_500_000,
      targetRepo: "ChinGuang/todo",
    });
  });

  it("starts gated, and keeps the commits local without a Target Repo", async () => {
    const startRun = vi.fn<RunsApi["startRun"]>(async () => SUMMARY);
    const { api } = fakeApi({ runs: [], startRun });
    render(<RunsPage api={api} search="" now={NOW} />);

    fireEvent.change(screen.getByLabelText(/Project request/), {
      target: { value: "Todo app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await vi.waitFor(() => expect(startRun).toHaveBeenCalled());
    expect(startRun.mock.calls[0]![0]).toMatchObject({
      mode: "gated",
      tokenBudget: 2_000_000,
      targetRepo: null,
    });
  });

  it("cannot start a Run with no request", () => {
    const { api } = fakeApi({ runs: [] });
    render(<RunsPage api={api} search="" now={NOW} />);

    expect(screen.getByRole("button", { name: "Start run" })).toBeDisabled();
  });

  it("shows every problem the server found, and stays on the form", async () => {
    const { api } = fakeApi({
      runs: [],
      startRun: async () => {
        throw new ApiError(400, "The request does not fit.", [
          "tokenBudget: Too small",
        ]);
      },
    });
    render(<RunsPage api={api} search="" now={NOW} />);

    fill();
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The request does not fit.");
    expect(alert).toHaveTextContent("tokenBudget: Too small");
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("button", { name: "Start run" })).toBeEnabled();
  });

  // The runtime checks its keys when a Run starts; its 503 says which.
  it("shows why the server cannot start a Run", async () => {
    const { api } = fakeApi({
      runs: [],
      startRun: async () => {
        throw new ApiError(503, "NEBIUS_API_KEY is not set.");
      },
    });
    render(<RunsPage api={api} search="" now={NOW} />);

    fill();
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "NEBIUS_API_KEY is not set.",
    );
  });
});
