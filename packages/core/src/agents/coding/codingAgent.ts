/**
 * The Backend and Frontend Coding Agents (CONTEXT.md): each builds its side of
 * a Slice in its own Workspace, at the same time as the other. The agent
 * writes files; saving, merging and testing them is the Orchestrator's.
 */
import type { AgentLoop, AgentLoopResult } from "../../agentLoop/agentLoop.js";
import type { AgentTool } from "../../agentLoop/tools.js";
import type { UiCanvas } from "../uiDesign/uiCanvas.js";
import { codingContext, type CodingTaskInput } from "./codingContext.js";
import { fileTools, penpotTools } from "./codingTools.js";
import {
  LocalWorkspaceFiles,
  type FileChange,
  type WorkspaceFiles,
} from "./workspaceFiles.js";

export type CodingInput = CodingTaskInput & {
  /** The Workspace's worktree (WorkspaceManager.openWorkspace). */
  workspaceDir: string;
  /** The Run's Penpot page, for the live design tools; null without one. */
  penpotPage: string | null;
};

export type CodingResult = {
  /** The agent's summary; null unless it answered. */
  summary: string | null;
  /**
   * Why this Step did not deliver, for the Orchestrator to retry or escalate:
   * the loop stopped early, or the agent answered without changing a file.
   * Null when it answered with changes.
   */
  problem: "notAnswered" | "noChanges" | null;
  /** The files it wrote or deleted, for the Step's record. */
  changes: FileChange[];
  loop: AgentLoopResult;
};

/** One Coding Agent Step: build or fix one side of a Slice. */
export interface CodingAgent {
  code: (input: CodingInput) => Promise<CodingResult>;
}

export type CodingAgentOptions = {
  createLoop: (tools: AgentTool[]) => AgentLoop;
  /** Needed only for a model with `penpotMcp`. */
  canvas?: Pick<UiCanvas, "describeScreen">;
  /** Defaults to the Workspace's files on disk. */
  openFiles?: (input: CodingInput) => WorkspaceFiles;
};

export class LoopCodingAgent implements CodingAgent {
  #createLoop: CodingAgentOptions["createLoop"];
  #canvas: CodingAgentOptions["canvas"];
  #openFiles: (input: CodingInput) => WorkspaceFiles;

  constructor(options: CodingAgentOptions) {
    this.#createLoop = options.createLoop;
    this.#canvas = options.canvas;
    this.#openFiles =
      options.openFiles ??
      ((input) =>
        new LocalWorkspaceFiles({
          root: input.workspaceDir,
          writable: input.profile.writablePaths[input.side],
        }));
  }

  code = async (input: CodingInput): Promise<CodingResult> => {
    const context = codingContext({
      ...input,
      // Without a canvas and a page there is no live design to read.
      capabilities: {
        ...input.capabilities,
        penpotMcp:
          input.capabilities.penpotMcp &&
          this.#canvas !== undefined &&
          input.penpotPage !== null,
      },
    });
    const files = this.#openFiles(input);
    const tools = [
      ...fileTools(files),
      ...(context.usePenpotTools && this.#canvas && input.penpotPage
        ? penpotTools(this.#canvas, input.penpotPage, context.screens)
        : []),
    ];
    const loop = await this.#createLoop(tools).run(context.task);
    const changes = files.changes();
    // Spike T03 rule 6: judge the Step by what it did, not what it says.
    const problem =
      loop.stopReason !== "answered"
        ? "notAnswered"
        : changes.length === 0
          ? "noChanges"
          : null;
    return { summary: loop.answer, problem, changes, loop };
  };
}
