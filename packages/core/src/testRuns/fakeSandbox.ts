/** Test helper: a SandboxClient that records what it was asked and runs nothing. */
import type {
  OperationResponse,
  RunResult,
  SandboxClient,
  SpawnRequest,
} from "@sdlc-code/clients";
import { RESULT_MARKER, type TestStep } from "@sdlc-code/stack-profiles";

export type FakeSandbox = SandboxClient & {
  uploads: string[];
  runs: SpawnRequest[];
  imports: string[];
};

export function fakeSandbox({
  images = [{ uuid: "node-img", tag: "sdlc-code/node:22-slim" }],
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
    operationId: `op-run`,
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
