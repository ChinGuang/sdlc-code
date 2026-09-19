/**
 * The System Design Agent (CONTEXT.md): turns a Project Request into the System
 * Design, Slice Plan and API Contract. Each part is submitted and validated by
 * its own tool, then finish_design checks them against each other. Small parts
 * keep Nemotron's tool arguments well-formed, and a rejected part is resent
 * alone instead of the whole design.
 */
import { stringify as toYaml } from "yaml";
import type { AgentLoop, AgentLoopResult } from "../../agentLoop/agentLoop.js";
import { defineTool, type AgentTool } from "../../agentLoop/tools.js";
import { z } from "zod";
import {
  ApiContractPart,
  SlicePlanPart,
  SystemDesignPart,
  type Design,
} from "./design.js";
import {
  apiContractProblems,
  parseApiContract,
  sliceContractProblems,
  slicePlanProblems,
  systemDesignProblems,
} from "./validateDesign.js";

export type SystemDesignInput = {
  projectRequest: string;
  /** The Stack Profile the application is built with (T12). */
  stackProfile: string;
  /** A revision after the Design Gate: the rejected design and the Verdict comments. */
  revision?: { previous: Design; comments: string[] };
};

export type SystemDesignResult = {
  /** The design finish_design accepted; null if none was. */
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

export const DESIGN_TOOLS = {
  systemDesign: "submit_system_design",
  slicePlan: "submit_slice_plan",
  apiContract: "submit_api_contract",
  finish: "finish_design",
} as const;

export const SYSTEM_DESIGN_PROMPT = `You are the System Design Agent of sdlc-code, a multi-agent tool that builds full-stack applications.

Design the application for the Project Request. Submit it in parts, one tool call each:
1. ${DESIGN_TOOLS.systemDesign}: an overview in Markdown and Mermaid diagrams, at least a component flowchart and a classDiagram of the domain. Mermaid source only, no \`\`\` fences. Put node labels that contain spaces or punctuation in double quotes, e.g. Api["API client (fetch)"].
2. ${DESIGN_TOOLS.slicePlan}: ordered vertical Slices, each built end to end (backend, frontend, tests). Slice 1 is always the Walking Skeleton: the template, database, GET /health and one empty screen, no feature endpoints. Then one Slice per feature, smallest useful first. List each Slice's endpoints as "METHOD /path", e.g. "GET /todos/{id}".
3. ${DESIGN_TOOLS.apiContract}: one OpenAPI 3.1.0 document, as YAML text, with every endpoint and its request and response schemas. Every operation belongs to exactly one Slice, with paths matching the Slice Plan exactly.
4. ${DESIGN_TOOLS.finish}: checks the parts against each other.

Keep the API as small as the request allows. When a tool returns errors, fix them and resubmit only that part. After ${DESIGN_TOOLS.finish} accepts the design, reply with one sentence summarising it.`;

type Drafts = Partial<Design>;

export class LoopSystemDesignAgent implements SystemDesignAgent {
  #createLoop: SystemDesignAgentOptions["createLoop"];

  constructor(options: SystemDesignAgentOptions) {
    this.#createLoop = options.createLoop;
  }

  design = async (input: SystemDesignInput): Promise<SystemDesignResult> => {
    const drafts: Drafts = {};
    let accepted: Design | null = null;
    const tools = designTools(drafts, (design) => {
      accepted = design;
    });
    const loop = await this.#createLoop(tools).run({
      system: SYSTEM_DESIGN_PROMPT,
      user: userMessage(input),
    });
    return { design: accepted, loop };
  };
}

/** Throws the problems back to the model, or returns `saved`. */
function verdict(part: string, problems: string[], saved: string): string {
  if (problems.length > 0)
    throw new Error(
      `${part} rejected. Fix every problem and resubmit it:\n- ${problems.join("\n- ")}`,
    );
  return saved;
}

function designTools(
  drafts: Drafts,
  accept: (design: Design) => void,
): AgentTool[] {
  return [
    defineTool({
      name: DESIGN_TOOLS.systemDesign,
      description: "Submit the System Design: overview and Mermaid diagrams.",
      input: SystemDesignPart,
      run: async (systemDesign) => {
        const problems = await systemDesignProblems(systemDesign);
        if (problems.length === 0) drafts.systemDesign = systemDesign;
        return verdict("System Design", problems, "System Design saved.");
      },
    }),
    defineTool({
      name: DESIGN_TOOLS.slicePlan,
      description:
        "Submit the Slice Plan: ordered Slices, the Walking Skeleton first.",
      input: SlicePlanPart,
      run: ({ slices }) => {
        const problems = slicePlanProblems(slices);
        if (problems.length === 0) drafts.slicePlan = slices;
        return verdict("Slice Plan", problems, "Slice Plan saved.");
      },
    }),
    defineTool({
      name: DESIGN_TOOLS.apiContract,
      description:
        "Submit the API Contract: an OpenAPI 3.1.0 document as YAML.",
      input: ApiContractPart,
      run: async ({ openapi }) => {
        const parsed = parseApiContract(openapi);
        if ("problem" in parsed)
          return verdict("API Contract", [parsed.problem], "");
        const problems = await apiContractProblems(parsed.contract);
        if (problems.length === 0) drafts.apiContract = parsed.contract;
        return verdict("API Contract", problems, "API Contract saved.");
      },
    }),
    defineTool({
      name: DESIGN_TOOLS.finish,
      description:
        "Check the saved System Design, Slice Plan and API Contract against each other and finish.",
      input: z.object({}),
      run: () => {
        const { systemDesign, slicePlan, apiContract } = drafts;
        const missing = [
          !systemDesign && DESIGN_TOOLS.systemDesign,
          !slicePlan && DESIGN_TOOLS.slicePlan,
          !apiContract && DESIGN_TOOLS.apiContract,
        ].filter((name) => name !== false);
        if (!systemDesign || !slicePlan || !apiContract)
          return verdict(
            "Design",
            [`Nothing valid saved yet from ${missing.join(", ")}.`],
            "",
          );
        const problems = sliceContractProblems(slicePlan, apiContract);
        if (problems.length === 0)
          accept({ systemDesign, slicePlan, apiContract });
        return verdict(
          "Design",
          problems,
          "Design accepted. Reply with one sentence summarising it.",
        );
      },
    }),
  ];
}

function userMessage(input: SystemDesignInput): string {
  const parts = [
    `Project Request:\n${input.projectRequest}`,
    `Stack Profile:\n${input.stackProfile}`,
  ];
  if (input.revision) {
    const { previous, comments } = input.revision;
    parts.push(
      `Revise your previous design and submit every part again. Reviewer comments:\n- ${comments.join("\n- ")}`,
      `Previous System Design and Slice Plan:\n${JSON.stringify({ systemDesign: previous.systemDesign, slicePlan: previous.slicePlan })}`,
      `Previous API Contract:\n${toYaml(previous.apiContract)}`,
    );
  }
  return parts.join("\n\n");
}
