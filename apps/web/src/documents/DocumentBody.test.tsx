/**
 * Each design document read as what it is, not as the JSON the agents wrote,
 * with the text itself one tab away, and a document of the wrong shape shown
 * as written rather than as nothing.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  API_CONTRACT,
  PENPOT_DESIGN,
  SLICE_PLAN,
  SYSTEM_DESIGN,
  UI_SPEC,
} from "../testing/documentFixtures.js";
import { DocumentBody } from "./DocumentBody.js";

// jsdom draws no SVG; a diagram is drawn as its source says.
vi.mock("mermaid", () => ({
  default: {
    initialize: () => {},
    render: async (_id: string, source: string) => ({
      svg: `<svg aria-label="diagram"><text>${source.split("\n")[0]}</text></svg>`,
    }),
  },
}));

describe("DocumentBody: the System Design", () => {
  it("reads as headings, text, lists and a drawn diagram", async () => {
    render(<DocumentBody kind="systemDesign" content={SYSTEM_DESIGN} />);

    expect(
      screen.getByRole("heading", { name: "Calendar" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Components" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Node API", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Prisma", { selector: "code" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(await screen.findByLabelText("diagram")).toHaveTextContent(
      "flowchart LR",
    );
  });

  // What a model wrote is shown as text, never as markup.
  it("never turns what the agent wrote into markup", () => {
    render(
      <DocumentBody
        kind="systemDesign"
        content={
          '<img src=x onerror="alert(1)"> and [a link](javascript:alert(1))'
        }
      />,
    );

    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
  });
});

describe("DocumentBody: the Slice Plan", () => {
  it("reads as numbered Slices, the Walking Skeleton marked, with their endpoints", () => {
    render(<DocumentBody kind="slicePlan" content={SLICE_PLAN} />);

    const slices = screen.getAllByRole("listitem");
    expect(slices).toHaveLength(2);
    expect(slices[0]).toHaveTextContent(
      "Slice 1Walking Skeletonwalking skeleton",
    );
    expect(slices[0]).toHaveTextContent("GET /health");
    expect(slices[1]).toHaveTextContent(
      "A person signs in with email and password.",
    );
    expect(slices[1]).not.toHaveTextContent("walking skeleton");
  });
});

describe("DocumentBody: the API Contract", () => {
  it("lists every endpoint with the Slice that builds it", () => {
    render(
      <DocumentBody
        kind="apiContract"
        content={API_CONTRACT}
        slicePlan={SLICE_PLAN}
      />,
    );

    const rows = within(
      screen.getByRole("table", { name: "Endpoints" }),
    ).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "GET/healthHealth checkSlice 1",
      "POST/api/auth/loginSign inSlice 2",
    ]);
  });

  it("shows the chosen endpoint's request and responses, references followed", () => {
    render(<DocumentBody kind="apiContract" content={API_CONTRACT} />);

    fireEvent.click(screen.getByRole("button", { name: "/api/auth/login" }));

    const operation = screen.getByRole("region", {
      name: "POST /api/auth/login",
    });
    expect(operation).toHaveTextContent("Request body · Credentials");
    expect(operation).toHaveTextContent("email *string");
    expect(operation).toHaveTextContent("password *stringmin length 8");
    expect(operation).toHaveTextContent("200 Signed in → Session");
    expect(operation).toHaveTextContent("401 Wrong email or password");
  });

  it("lists the shared schemas", () => {
    render(<DocumentBody kind="apiContract" content={API_CONTRACT} />);

    fireEvent.click(screen.getByRole("button", { name: "Schemas 2" }));

    expect(
      screen.getByRole("region", { name: "Schema Session" }),
    ).toHaveTextContent("tokenstring");
  });
});

describe("DocumentBody: the UI Spec and the Penpot design", () => {
  it("reads the UI Spec as its tokens and screens, each with a wireframe", () => {
    render(<DocumentBody kind="uiSpec" content={UI_SPEC} />);

    expect(screen.getByLabelText("Design tokens")).toHaveTextContent(
      "accent #76B900",
    );
    const signIn = screen.getByRole("region", { name: "Screen Sign in" });
    expect(signIn).toHaveTextContent("Sign in /login");
    expect(signIn).toHaveTextContent("States: idle, error");
    expect(within(signIn).getByRole("img")).toHaveAccessibleName(
      'Layout of Sign in: heading "Welcome back", input "Email", button "Sign in"',
    );
  });

  it("reads the Penpot design as its page and screens", () => {
    render(<DocumentBody kind="penpotDesign" content={PENPOT_DESIGN} />);

    expect(screen.getByText("#27f388 A calendar app")).toBeInTheDocument();
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["Screen: Sign in", "Screen: Calendar"]);
  });
});

describe("DocumentBody: Raw, and what cannot be read", () => {
  it("shows the text as the agents wrote it on Raw", () => {
    render(<DocumentBody kind="slicePlan" content={SLICE_PLAN} />);

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));

    expect(screen.getByLabelText("Raw document").textContent).toBe(SLICE_PLAN);
    fireEvent.click(screen.getByRole("button", { name: "Readable" }));
    expect(screen.queryByLabelText("Raw document")).toBeNull();
  });

  it("shows a document of the wrong shape as written, and says so", () => {
    render(<DocumentBody kind="apiContract" content="openapi: 3.1.0" />);

    expect(screen.getByRole("status")).toHaveTextContent(/not in the shape/);
    expect(screen.getByText("openapi: 3.1.0")).toBeInTheDocument();
  });
});
