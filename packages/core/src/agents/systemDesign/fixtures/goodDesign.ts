import type { Design } from "../design.js";

/** A valid design for a small todo app; tests break one rule at a time. */
export function goodDesign(): Design {
  return {
    systemDesign: {
      overview:
        "A React + Vite frontend talks to a Node API over REST. The API stores todos with Prisma.",
      diagrams: [
        {
          title: "Components",
          mermaid:
            "flowchart LR\n  Web[React app] -->|REST| API[Node API]\n  API --> DB[(Database)]",
        },
        {
          title: "Domain",
          mermaid:
            "classDiagram\n  class Todo {\n    id: string\n    title: string\n    done: boolean\n  }",
        },
      ],
    },
    slicePlan: [
      {
        title: "Walking Skeleton",
        goal: "The app boots, reports health and shows an empty page.",
        isWalkingSkeleton: true,
        endpoints: ["GET /health"],
      },
      {
        title: "Todos",
        goal: "A user can list, add and complete todos.",
        isWalkingSkeleton: false,
        endpoints: ["GET /todos", "POST /todos", "PATCH /todos/{id}"],
      },
    ],
    apiContract: {
      openapi: "3.1.0",
      info: { title: "Todo API", version: "1.0.0" },
      paths: {
        "/health": {
          get: { responses: { "200": { description: "The API is up" } } },
        },
        "/todos": {
          get: { responses: { "200": { description: "All todos" } } },
          post: { responses: { "201": { description: "Created" } } },
        },
        "/todos/{id}": {
          patch: {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: { "200": { description: "Updated" } },
          },
        },
      },
    },
  };
}
