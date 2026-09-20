/**
 * The UI Design Agent (CONTEXT.md): writes the UI Spec for the Approved
 * Documents and draws every screen on the Run's Penpot page.
 *
 * The model submits the spec (validated against the Slice Plan and API
 * Contract); the drawing itself is done in code, so a design can never fail on
 * model-written plugin JavaScript.
 */
import type { ExportedImage } from "@sdlc-code/clients";
import type { AgentLoop, AgentLoopResult } from "../../agentLoop/agentLoop.js";
import { defineTool, type AgentTool } from "../../agentLoop/tools.js";
import type { DesignSlice } from "../systemDesign/design.js";
import { contractEndpoints } from "../systemDesign/validateDesign.js";
import { UiSpecSchema, type UiSpec } from "./uiSpec.js";
import type { UiCanvas } from "./uiCanvas.js";
import { uiSpecProblems } from "./validateUiSpec.js";

export type UiDesignInput = {
  projectRequest: string;
  /** The Run's page in the Penpot Workspace File (see runPageName). */
  pageName: string;
  slicePlan: DesignSlice[];
  apiContract: Record<string, unknown>;
  /** A revision after the Design Gate, or because the design went Stale. */
  revision?: { previous: UiSpec; comments: string[] };
};

export type DrawnScreen = {
  name: string;
  boardId: string;
  export: ExportedImage | null;
};

/** The Run's Penpot page, which the Design Gate links to (ADR 0002). */
export type RunPageLink = {
  name: string;
  pageId: string;
  fileId: string | null;
  /** Boards of screens an earlier version had, removed by this design. */
  removedBoards: string[];
};

export type UiDesignResult = {
  /** The UI Spec that passed validation; null if none did. */
  spec: UiSpec | null;
  /** What was drawn in Penpot; empty when no spec passed. */
  screens: DrawnScreen[];
  /** Where it was drawn; null when no spec passed. */
  page: RunPageLink | null;
  loop: AgentLoopResult;
};

export interface UiDesignAgent {
  design: (input: UiDesignInput) => Promise<UiDesignResult>;
}

export type UiDesignAgentOptions = {
  createLoop: (tools: AgentTool[]) => AgentLoop;
  canvas: UiCanvas;
  /** Export a PNG of every board once it is drawn. Default true. */
  exportBoards?: boolean;
};

export const SUBMIT_UI_SPEC = "submit_ui_spec";

export const UI_DESIGN_PROMPT = `You are the UI Design Agent of sdlc-code, a multi-agent tool that builds full-stack applications.

Design every screen of the application from the Slice Plan and API Contract, then call ${SUBMIT_UI_SPEC} once with:
- tokens: background, surface, text and accent colours as #RRGGBB, and a font family. Keep contrast high.
- screens: one per user-facing screen. Give each its name, route, purpose, the Slice it belongs to, the API Contract operations it calls ("GET /todos"), its states (loading, empty, error, …), and its layout.

Layout rules:
- Each screen is a 1280x800 board. Every element needs kind, label, x, y, width, height, and must fit inside the board.
- Element kinds: heading, text, button, input, list, card, image, nav.
- Leave a 64px margin, align elements on a grid, and keep 16-24px between them. Do not overlap elements.
- Every Slice needs at least one screen, and every endpoint except GET /health must be called by some screen.

Your spec is the source of truth for the frontend, so make the labels concrete (real button and field text, not "Button 1"). If ${SUBMIT_UI_SPEC} returns errors, fix all of them and call it again. After it is accepted, reply with one sentence describing the design.`;

export class LoopUiDesignAgent implements UiDesignAgent {
  #createLoop: UiDesignAgentOptions["createLoop"];
  #canvas: UiCanvas;
  #exportBoards: boolean;

  constructor(options: UiDesignAgentOptions) {
    this.#createLoop = options.createLoop;
    this.#canvas = options.canvas;
    this.#exportBoards = options.exportBoards ?? true;
  }

  design = async (input: UiDesignInput): Promise<UiDesignResult> => {
    // Spike T02: check the plugin before spending a Step on a design we cannot draw.
    await this.#canvas.checkConnection();

    let accepted: UiSpec | null = null;
    const submit = defineTool({
      name: SUBMIT_UI_SPEC,
      description:
        "Submit the UI Spec: design tokens and every screen with its layout. Returns validation errors to fix, or confirms acceptance.",
      input: UiSpecSchema,
      run: (spec) => {
        const problems = uiSpecProblems(spec, {
          slicePlan: input.slicePlan,
          apiContract: input.apiContract,
        });
        accepted = problems.length === 0 ? spec : null;
        if (problems.length > 0)
          throw new Error(
            `UI Spec rejected. Fix every problem and submit again:\n- ${problems.join("\n- ")}`,
          );
        return "UI Spec accepted. Reply with one sentence describing the design.";
      },
    });

    const loop = await this.#createLoop([submit]).run({
      system: UI_DESIGN_PROMPT,
      user: userMessage(input),
    });
    const spec: UiSpec | null = accepted;
    if (!spec) return { spec: null, screens: [], page: null, loop };
    const { screens, page } = await this.#draw(input.pageName, spec);
    return { spec, screens, page, loop };
  };

  async #draw(
    pageName: string,
    spec: UiSpec,
  ): Promise<{ screens: DrawnScreen[]; page: RunPageLink }> {
    const runPage = await this.#canvas.ensurePage(pageName);
    const drawn: DrawnScreen[] = [];
    for (const [index, screen] of spec.screens.entries()) {
      const board = await this.#canvas.drawScreen({
        pageName,
        index,
        screen,
        tokens: spec.tokens,
      });
      drawn.push({
        name: screen.name,
        boardId: board.boardId,
        export: this.#exportBoards
          ? await this.#canvas.exportBoard(board.boardId)
          : null,
      });
    }
    // A revision may have renamed or dropped screens; their boards must go.
    const removed = await this.#canvas.sweepBoards(
      pageName,
      spec.screens.map((screen) => screen.name),
    );
    return {
      screens: drawn,
      page: {
        name: pageName,
        pageId: runPage.pageId,
        fileId: runPage.fileId,
        removedBoards: removed,
      },
    };
  }
}

function userMessage(input: UiDesignInput): string {
  const endpoints = contractEndpoints(input.apiContract);
  const slices = input.slicePlan
    .map(
      (slice) =>
        `- ${slice.title}: ${slice.goal} (endpoints: ${slice.endpoints.join(", ") || "none"})`,
    )
    .join("\n");
  const parts = [
    `Project Request:\n${input.projectRequest}`,
    `Slice Plan:\n${slices}`,
    `API Contract operations:\n${endpoints.map((endpoint) => `- ${endpoint}`).join("\n")}`,
    `API Contract (JSON):\n${JSON.stringify(input.apiContract)}`,
  ];
  if (input.revision)
    parts.push(
      `Revise your previous UI Spec and submit all screens again. Comments:\n- ${input.revision.comments.join("\n- ")}`,
      `Previous UI Spec:\n${JSON.stringify(input.revision.previous)}`,
    );
  return parts.join("\n\n");
}
