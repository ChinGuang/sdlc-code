import { goodDesign } from "../../systemDesign/fixtures/goodDesign.js";
import type { UiSpecContext } from "../validateUiSpec.js";
import type { UiSpec } from "../uiSpec.js";

/** The design the UI Spec below was written against. */
export function uiSpecContext(): UiSpecContext {
  const design = goodDesign();
  return { slicePlan: design.slicePlan, apiContract: design.apiContract };
}

/** A valid UI Spec for the todo app; tests break one rule at a time. */
export function goodUiSpec(): UiSpec {
  return {
    tokens: {
      background: "#0B0F14",
      surface: "#131A22",
      text: "#E6EDF3",
      accent: "#3FB950",
      fontFamily: "Inter",
    },
    screens: [
      {
        name: "Health",
        route: "/health",
        purpose: "Shows that the app and API are running.",
        sliceTitle: "Walking Skeleton",
        endpoints: ["GET /health"],
        states: ["loading", "ok", "error"],
        elements: [
          {
            kind: "heading",
            label: "Todo",
            x: 64,
            y: 48,
            width: 400,
            height: 56,
          },
          {
            kind: "text",
            label: "API status: ok",
            x: 64,
            y: 120,
            width: 400,
            height: 32,
          },
        ],
      },
      {
        name: "Todo list",
        route: "/",
        purpose: "A user lists, adds and completes todos.",
        sliceTitle: "Todos",
        endpoints: ["GET /todos", "POST /todos", "PATCH /todos/{id}"],
        states: ["loading", "empty", "error"],
        elements: [
          {
            kind: "heading",
            label: "Your todos",
            x: 64,
            y: 48,
            width: 600,
            height: 56,
          },
          {
            kind: "input",
            label: "What needs doing?",
            x: 64,
            y: 128,
            width: 480,
            height: 48,
          },
          {
            kind: "button",
            label: "Add",
            x: 560,
            y: 128,
            width: 120,
            height: 48,
          },
          {
            kind: "list",
            label: "Todo items",
            x: 64,
            y: 208,
            width: 616,
            height: 420,
          },
        ],
      },
    ],
  };
}
