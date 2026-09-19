/**
 * The System Design Agent (CONTEXT.md): turns a Project Request into the System
 * Design, Slice Plan and API Contract. It submits them through one tool that
 * validates them, so the model fixes its own mistakes inside the same Step.
 */
import type { AgentLoop, AgentLoopResult } from "../../agentLoop/agentLoop.js";
import { defineTool, type AgentTool } from "../../agentLoop/tools.js";
import { DesignSubmission, type Design } from "./design.js";
import { validateDesign } from "./validateDesign.js";

export type SystemDesignInput = {
  projectRequest: string;
  /** The Stack Profile the application is built with (T12). */
  stackProfile: string;
  /** A revision after the Design Gate: the rejected design and the Verdict comments. */
  revision?: { previous: Design; comments: string[] };
};

export type SystemDesignResult = {
  /** The last design that passed validation; null if none did. */
  design: Design | null;
  loop: AgentLoopResult;
};

export interface SystemDesignAgent {
  design: (input: SystemDesignInput) => Promise<SystemDesignResult>;
}

export type SystemDesignAgentOptions = {
  /** Builds the agent loop for one Step (client, role model, Transcript, budget). */
  createLoop: (tools: AgentTool[]) => AgentLoop;
};

export const SUBMIT_DESIGN = "submit_design";

export const SYSTEM_DESIGN_PROMPT = `You are the System Design Agent of sdlc-code, a multi-agent tool that builds full-stack applications.

Design the application for the Project Request, then call ${SUBMIT_DESIGN} once with three JSON objects (not strings):
- systemDesign: an overview in Markdown and Mermaid diagrams: at least a component flowchart and a classDiagram of the domain. Mermaid source only, no \`\`\` fences. Put node labels that contain spaces or punctuation in double quotes, e.g. Api["API client (fetch)"].
- slicePlan: ordered vertical Slices, each built end to end (backend, frontend, tests). Slice 1 is always the Walking Skeleton: the template, database, GET /health and one empty screen, no feature endpoints. Then one Slice per feature, smallest useful first.
- apiContract: one OpenAPI 3.1.0 document with every endpoint, request and response schema. List each operation in exactly one Slice's endpoints as "METHOD /path" (e.g. "GET /todos/{id}"), matching the contract's paths exactly.

Keep the API as small as the request allows. If ${SUBMIT_DESIGN} returns errors, fix all of them and call it again. After it is accepted, reply with one sentence summarising the design.`;

export class NemotronSystemDesignAgent implements SystemDesignAgent {
  #createLoop: SystemDesignAgentOptions["createLoop"];

  constructor(options: SystemDesignAgentOptions) {
    this.#createLoop = options.createLoop;
  }

  design = async (input: SystemDesignInput): Promise<SystemDesignResult> => {
    let accepted: Design | null = null;
    const submit = defineTool({
      name: SUBMIT_DESIGN,
      description:
        "Submit the System Design, Slice Plan and API Contract. Returns validation errors to fix, or confirms acceptance.",
      input: DesignSubmission,
      run: async (design) => {
        const problems = await validateDesign(design);
        if (problems.length > 0)
          throw new Error(
            `Design rejected. Fix every problem and submit again:\n- ${problems.join("\n- ")}`,
          );
        accepted = design;
        return "Design accepted. Reply with one sentence summarising it.";
      },
    });

    const loop = await this.#createLoop([submit]).run({
      system: SYSTEM_DESIGN_PROMPT,
      user: userMessage(input),
    });
    return { design: accepted, loop };
  };
}

function userMessage(input: SystemDesignInput): string {
  const parts = [
    `Project Request:\n${input.projectRequest}`,
    `Stack Profile:\n${input.stackProfile}`,
  ];
  if (input.revision)
    parts.push(
      `Revise your previous design. Reviewer comments:\n- ${input.revision.comments.join("\n- ")}`,
      `Previous design:\n${JSON.stringify(input.revision.previous)}`,
    );
  return parts.join("\n\n");
}
