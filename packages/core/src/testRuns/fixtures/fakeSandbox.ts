/** Test helper: a SandboxClient that records what it was asked and runs nothing. */
import type {
  OperationResponse,
  RunResult,
  SandboxClient,
  SpawnRequest,
} from "@sdlc-code/clients";
import {
  LINT_MARKER,
  RESULT_MARKER,
  type LintProblem,
  type TestStep,
} from "@sdlc-code/stack-profiles";

export type FakeSandbox = SandboxClient & {
  uploads: string[];
  runs: SpawnRequest[];
  imports: string[];
};

export function fakeSandbox({
  images = [{ uuid: "node-img", tag: "sdlc-code/node:22" }],
  onRun = () => ranOk(),
}: {
  images?: Array<{ uuid: string; tag?: string }>;
  onRun?: (request: SpawnRequest) => RunResult | Promise<RunResult>;
} = {}): FakeSandbox {
  const uploads: string[] = [];
  const runs: SpawnRequest[] = [];
  const imports: string[] = [];
  const done = (uuid: string): OperationResponse => ({
    uuid,
    kind: "instance",
    status: "SUCCESS",
  });
  return {
    uploads,
    runs,
    imports,
    listImages: async (tagPrefix) => ({
      images: images.filter((image) => image.tag?.startsWith(tagPrefix ?? "")),
    }),
    importImage: async (registryUrl) => {
      imports.push(registryUrl);
      return "op-import";
    },
    uploadFile: async (content) => {
      uploads.push(String(content));
      return { uuid: `file-${uploads.length}`, sha256: "", size: 0 };
    },
    spawn: async () => "op",
    getOperation: async (id) => done(id),
    waitForOperation: async (id) => done(id),
    run: async (request) => {
      runs.push(request);
      return onRun(request);
    },
    whoAmI: async () => ({ permissions: {}, limits: {} }),
  };
}

export function ranOk(overrides: Partial<RunResult> = {}): RunResult {
  return {
    operationId: "op-run",
    status: "SUCCESS",
    exitCode: 0,
    timedOut: false,
    stdout: "",
    stderr: "",
    resultImage: "snapshot-img",
    durationSeconds: 1,
    cost: 0.001,
    error: null,
    ...overrides,
  };
}

/** What the Stack Profile's test script prints for these step outcomes. */
/** A lint script's output: noise, then its one SDLC_LINT line. */
export function lintOutput(
  problems: Array<Partial<LintProblem> & Pick<LintProblem, "tool">>,
  checks?: Array<{ name: LintProblem["tool"]; ok: boolean; output?: string }>,
): string {
  const result = {
    profile: "react-node",
    checks: (
      checks ?? [
        { name: "eslint" as const, ok: !problems.some(isError) },
        { name: "tsc" as const, ok: !problems.some((p) => p.tool === "tsc") },
      ]
    ).map((check) => ({ durationMs: 1, output: "", ...check })),
    problems: problems.map((problem) => ({
      severity: "error" as const,
      file: "src/App.tsx",
      line: 3,
      rule: "no-unused-vars",
      message: "'x' is defined but never used.",
      ...problem,
    })),
    durationMs: 5,
  };
  return `eslint chatter
${LINT_MARKER}${JSON.stringify(result)}
`;
}

const isError = (problem: { tool: string; severity?: string }) =>
  problem.tool === "eslint" && (problem.severity ?? "error") === "error";

export function scriptOutput(
  steps: Array<Partial<TestStep> & Pick<TestStep, "name" | "ok">>,
): string {
  const result = {
    profile: "react-node",
    passed: steps.every((step) => step.ok),
    steps: steps.map((step) => ({ durationMs: 1, output: "", ...step })),
    durationMs: 5,
  };
  return `npm chatter\n${RESULT_MARKER}${JSON.stringify(result)}\n`;
}
