/**
 * Design documents as the agents write them (see packages/core's
 * designDocuments and the UI Design Agent), for the readable views' tests.
 */
export const SYSTEM_DESIGN = `# Calendar

A React + Vite frontend talks to a **Node API** over REST, with \`Prisma\` for storage.

- Events have a start and an end
- Times are stored in UTC

## Components

\`\`\`mermaid
flowchart LR
  Web[React app] -->|REST| API[Node API]
\`\`\`
`;

export const SLICE_PLAN = JSON.stringify(
  [
    {
      title: "Walking Skeleton",
      goal: "The app boots and reports health.",
      isWalkingSkeleton: true,
      endpoints: ["GET /health"],
    },
    {
      title: "Sign in",
      goal: "A person signs in with email and password.",
      isWalkingSkeleton: false,
      endpoints: ["POST /api/auth/login"],
    },
  ],
  null,
  2,
);

export const API_CONTRACT = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Calendar API", version: "1.0.0" },
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status"],
                  properties: {
                    status: { type: "string", example: "ok" },
                    timestamp: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/auth/login": {
      post: {
        summary: "Sign in",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Credentials" },
            },
          },
        },
        responses: {
          "200": {
            description: "Signed in",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Session" },
              },
            },
          },
          "401": { description: "Wrong email or password" },
        },
      },
    },
  },
  components: {
    schemas: {
      Credentials: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8 },
        },
      },
      Session: {
        type: "object",
        properties: { token: { type: "string" } },
      },
    },
  },
});

export const UI_SPEC = JSON.stringify({
  tokens: {
    background: "#0B0F14",
    surface: "#121821",
    text: "#E6EDF3",
    accent: "#76B900",
    fontFamily: "Inter",
  },
  screens: [
    {
      name: "Sign in",
      route: "/login",
      purpose: "A person signs in.",
      sliceTitle: "Sign in",
      endpoints: ["POST /api/auth/login"],
      states: ["idle", "error"],
      elements: [
        {
          kind: "heading",
          label: "Welcome back",
          x: 440,
          y: 160,
          width: 400,
          height: 48,
        },
        {
          kind: "input",
          label: "Email",
          x: 440,
          y: 240,
          width: 400,
          height: 44,
        },
        {
          kind: "button",
          label: "Sign in",
          x: 440,
          y: 320,
          width: 400,
          height: 44,
        },
      ],
    },
  ],
});

export const PENPOT_DESIGN = JSON.stringify({
  page: {
    name: "#27f388 A calendar app",
    pageId: "981ff1fa-0000-4000-8000-000000000001",
    fileId: "b564c72c-0000-4000-8000-000000000002",
    removedBoards: [],
  },
  screens: [
    { name: "Screen: Sign in", boardId: "b1" },
    { name: "Screen: Calendar", boardId: "b2" },
  ],
});
