/**
 * Each design document read as what it is, not as the JSON the agents wrote,
 * with the text itself one tab away, and a document of the wrong shape shown
 * as written rather than as nothing.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  API_CONTRACT,
  RICH_CONTRACT,
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
    render: async (_id: string, source: string) => {
      if (source.includes("broken")) throw new Error("Parse error");
      return {
        svg: `<svg aria-label="diagram"><text>${source.split("\n")[0]}</text></svg>`,
      };
    },
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

  it("shows a diagram that cannot be drawn as its source, and says so", async () => {
    render(
      <DocumentBody
        kind="systemDesign"
        content={"```mermaid\nflowchart broken\n```"}
      />,
    );

    expect(
      await screen.findByText("This diagram could not be drawn; its source:"),
    ).toBeInTheDocument();
    expect(screen.getByText("flowchart broken")).toBeInTheDocument();
  });

  // Database columns and arithmetic are not emphasis.
  it("leaves snake_case and 2*3*4 as written, and emphasises only whole words", () => {
    render(
      <DocumentBody
        kind="systemDesign"
        content="Stores created_at and snake_case_name; 2*3*4 is 24; this is _really_ *it*."
      />,
    );

    expect(document.querySelectorAll("em")).toHaveLength(2);
    expect(screen.getByText("really", { selector: "em" })).toBeInTheDocument();
    expect(
      screen.getByText(/created_at and snake_case_name; 2\*3\*4/),
    ).toBeInTheDocument();
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
    // The first row is the column headers, for a screen reader.
    expect(rows.slice(1).map((row) => row.textContent)).toEqual([
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

  it("follows references anywhere in the contract, and reads every type", () => {
    render(<DocumentBody kind="apiContract" content={RICH_CONTRACT} />);

    const operation = screen.getByRole("region", { name: "GET /events/{id}" });
    // The path's own parameter, by reference, then the operation's.
    expect(operation).toHaveTextContent("id *stringpath · uuid");
    expect(operation).toHaveTextContent("expandbooleanquery");
    // A response by reference, its schema an allOf of two.
    expect(operation).toHaveTextContent("200 The event → Event");
    expect(operation).toHaveTextContent("id *string");
    expect(operation).toHaveTextContent("title *string");
    expect(operation).toHaveTextContent("notestring | null");
    expect(operation).toHaveTextContent("endsAtstring | nulldate-time");
    expect(operation).toHaveTextContent("ownerstring | integer");
    expect(operation).toHaveTextContent('tags("work" | "home")[]');
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

    expect(
      screen.getByRole("region", { name: "Raw document" }).textContent,
    ).toBe(SLICE_PLAN);
    fireEvent.click(screen.getByRole("button", { name: "Readable" }));
    expect(screen.queryByRole("region", { name: "Raw document" })).toBeNull();
  });

  it.each([
    ["slicePlan", "[1, 2]"],
    ["uiSpec", '{"screens": []}'],
    ["penpotDesign", "{}"],
  ] as const)("does not read %s %s as one", (kind, content) => {
    render(<DocumentBody kind={kind} content={content} />);

    expect(screen.getByRole("status")).toHaveTextContent(/not in the shape/);
  });

  it("shows a document of the wrong shape as written, and says so", () => {
    render(<DocumentBody kind="apiContract" content="openapi: 3.1.0" />);

    expect(screen.getByRole("status")).toHaveTextContent(/not in the shape/);
    expect(screen.getByText("openapi: 3.1.0")).toBeInTheDocument();
  });
});
