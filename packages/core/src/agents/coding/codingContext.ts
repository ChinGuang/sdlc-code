/**
 * What a Coding Agent is told (T15): its Task, the Approved Documents, the
 * Issue Reports to fix and its Working Memory, plus design material the model
 * can use (Model Capabilities, CONTEXT.md): the UI Spec always, board PNGs
 * with `vision`, and live Penpot tools with `penpotMcp`.
 */
import type { ExportedImage } from "@sdlc-code/clients";
import type { CodingSide, StackProfile } from "@sdlc-code/stack-profiles";
import { stringify } from "yaml";
import type { AgentTask } from "../../agentLoop/agentLoop.js";
import type { ModelCapabilities } from "../../config/agentConfig.js";
import { HEALTH_ENDPOINT, type DesignSlice } from "../systemDesign/design.js";
import type { UiSpec } from "../uiDesign/uiSpec.js";
import { FILE_TOOL_NAMES, INSPECT_SCREEN } from "./codingTools.js";

/** A problem to fix: from a Test Run (T16), a Code Review Finding or a human. */
export type CodingIssue = { summary: string; evidence: string };

export type ApprovedDocuments = {
  /** Markdown, as the Design Gate approved it. */
  systemDesign: string;
  slicePlan: readonly DesignSlice[];
  apiContract: Record<string, unknown>;
  uiSpec: UiSpec;
};

export type CodingTaskInput = {
  side: CodingSide;
  profile: StackProfile;
  projectRequest: string;
  /** The Slice this Task builds. */
  slice: DesignSlice;
  documents: ApprovedDocuments;
  issueReports: readonly CodingIssue[];
  /** The note an earlier Step of this Task left (CONTEXT.md "Working Memory"). */
  workingMemory: string | null;
  capabilities: ModelCapabilities;
  /** The Design Phase's board exports, by screen name. */
  screenImages: ReadonlyMap<string, ExportedImage>;
};

export type CodingContext = {
  task: AgentTask;
  /** The Slice's screens, which the Penpot tool may inspect. */
  screens: string[];
  usePenpotTools: boolean;
};

const SIDE_NAMES: Record<CodingSide, string> = {
  backend: "Backend Coding Agent",
  frontend: "Frontend Coding Agent",
};

const SIDE_WORK: Record<CodingSide, string> = {
  backend:
    "You build the API: routes, validation, services and the database schema, with tests. Implement every endpoint of this Slice exactly as the API Contract defines it: paths, status codes and bodies.",
  frontend:
    "You build the screens: components, their states and the calls to the API, with tests. Build every screen of this Slice as the UI Spec lays it out, calling the API only as the API Contract defines it.",
};

export function codingContext(input: CodingTaskInput): CodingContext {
  const frontend = input.side === "frontend";
  const sliceScreens = input.documents.uiSpec.screens.filter(
    (screen) => screen.sliceTitle === input.slice.title,
  );
  // Design material (layout, images, the live design) is the frontend's.
  const screens = frontend ? sliceScreens : [];
  const images =
    frontend && input.capabilities.vision
      ? screens.flatMap((screen) => {
          const image = input.screenImages.get(screen.name);
          return image ? [{ name: screen.name, image }] : [];
        })
      : [];
  const usePenpotTools =
    frontend && input.capabilities.penpotMcp && screens.length > 0;

  const user = [
    `Project Request:\n${input.projectRequest}`,
    taskSection(input),
    ...issueSection(input.issueReports),
    ...(input.workingMemory
      ? [
          `Your notes from the previous attempt at this Task:\n${input.workingMemory}`,
        ]
      : []),
    `System Design:\n${input.documents.systemDesign.trim()}`,
    `Slice Plan:\n${slicePlanSection(input.documents.slicePlan, input.slice)}`,
    `API Contract (OpenAPI):\n${stringify(input.documents.apiContract).trim()}`,
    ...(frontend
      ? [
          `UI Spec for this Slice:\n${stringify({
            tokens: input.documents.uiSpec.tokens,
            screens,
          }).trim()}`,
        ]
      : sliceScreens.length > 0
        ? [
            `Screens of this Slice (from the UI Spec), which your API serves:\n${stringify(
              sliceScreens.map((screen) => ({
                name: screen.name,
                purpose: screen.purpose,
                endpoints: screen.endpoints,
                states: screen.states,
                fields: screen.elements
                  .filter((element) => element.kind === "input")
                  .map((element) => element.label),
              })),
            ).trim()}`,
          ]
        : []),
    ...(images.length > 0
      ? [
          `Attached: the design of each screen, in this order: ${images.map((image) => image.name).join(", ")}.`,
        ]
      : []),
    ...(usePenpotTools
      ? [
          `The live design is in Penpot; ${INSPECT_SCREEN} reads a screen as it is drawn now, which a designer may have adjusted.`,
        ]
      : []),
  ].join("\n\n");

  return {
    task: {
      system: systemPrompt(input.side, input.profile, usePenpotTools),
      user,
      ...(images.length > 0
        ? { images: images.map((image) => image.image) }
        : {}),
    },
    screens: screens.map((screen) => screen.name),
    usePenpotTools,
  };
}

function systemPrompt(
  side: CodingSide,
  profile: StackProfile,
  usePenpotTools: boolean,
): string {
  const rules = profile.reviewStandard
    .map((rule) => `- ${rule.id} (${rule.severity}): ${rule.description}`)
    .join("\n");
  const tools = [
    ...FILE_TOOL_NAMES,
    ...(usePenpotTools ? [INSPECT_SCREEN] : []),
  ].join(", ");
  return `You are the ${SIDE_NAMES[side]} of sdlc-code, a multi-agent tool that builds full-stack applications on the ${profile.name} stack (${profile.summary}).

${SIDE_WORK[side]}

How to work:
- Start by reading the files you will change and the ones they use (list_files, read_file). Reuse the helpers the application already has.
- You may write only: ${profile.writablePaths[side].join(", ")}. The other Coding Agent writes the rest at the same time; read its files, never change them.
- Every change comes with Vitest tests beside it. You cannot run them: when you finish, a Test Run installs, tests, boots and smoke-tests the merged Slice, and any failure comes back to you as an Issue Report.
- Never write secrets or real credentials; configuration comes from environment variables, with placeholders in .env.example.
- Keep files small and focused. Make small edits with edit_file, and write whole files only when creating them.

Your tools: ${tools}.

The code will be reviewed against these rules; blocking ones send your work back:
${rules}

When the Slice is built and tested, reply with a short summary: what you changed and how it is tested. No code in the reply.`;
}

function taskSection(input: CodingTaskInput): string {
  const endpoints =
    input.slice.endpoints.length > 0
      ? input.slice.endpoints.join(", ")
      : "none";
  return `Your Task: build the ${input.side} of Slice "${input.slice.title}".
Goal: ${input.slice.goal}
Endpoints of this Slice: ${endpoints}`;
}

function issueSection(issues: readonly CodingIssue[]): string[] {
  if (issues.length === 0) return [];
  const listed = issues
    .map(
      (issue, index) =>
        `${index + 1}. ${issue.summary}\n   Evidence: ${issue.evidence.trim().replaceAll("\n", "\n   ")}`,
    )
    .join("\n");
  return [
    `Fix these problems first; the Slice was sent back because of them:\n${listed}`,
  ];
}

/**
 * The sides a Slice needs a Coding Agent for: the backend when it builds an
 * endpoint the template does not already serve, the frontend when it has a
 * screen. The Walking Skeleton always gets both, to prove the stack end to end.
 */
export function codingSides(slice: DesignSlice, uiSpec: UiSpec): CodingSide[] {
  if (slice.isWalkingSkeleton) return ["backend", "frontend"];
  const sides: CodingSide[] = [];
  if (slice.endpoints.some((endpoint) => endpoint !== HEALTH_ENDPOINT))
    sides.push("backend");
  if (uiSpec.screens.some((screen) => screen.sliceTitle === slice.title))
    sides.push("frontend");
  return sides;
}

/** Earlier Slices are already built; later ones are not yours to start. */
function slicePlanSection(
  plan: readonly DesignSlice[],
  current: DesignSlice,
): string {
  const at = plan.findIndex((slice) => slice.title === current.title);
  return plan
    .map((slice, index) => {
      const state =
        index === at ? "this Task" : index < at ? "built" : "later, not yet";
      return `${index + 1}. ${slice.title} (${state}): ${slice.goal}`;
    })
    .join("\n");
}
