/**
 * Test Runs (CONTEXT.md): one disposable sandbox run of a Slice's merged code,
 * started from the Stack Profile's Base Snapshot with only the changed files
 * uploaded (ADR 0001). The sandbox only executes; the files come from the
 * Workspace every time.
 */
import {
  commandSucceeded,
  SandboxApiError,
  type RunResult,
  type SandboxClient,
} from "@sdlc-code/clients";
import {
  parseTestScriptOutput,
  templateFiles,
  type StackProfile,
  type TemplateFile,
  type TestScriptResult,
} from "@sdlc-code/stack-profiles";
import { describeRun, type BaseSnapshots } from "./baseSnapshots.js";
import {
  assertAppPath,
  isSecretFile,
  SANDBOX_APP_DIR,
  sha256,
  shellQuote,
  uploadFiles,
} from "./sandboxFiles.js";

/** Spike T01: generous for install + tests + boot + smoke, well under the 3,600 s cap. */
const TEST_RUN_TIMEOUT_SECONDS = 600;
/** Spike T01: 250 ms polling saves about a second per run over 1 s. */
const POLL_MS = 250;
/** Enough log for an Issue Report; the SDLC_RESULT line is always at its end. */
const LOG_TAIL_BYTES = 60_000;
const LOG_FILE = ".sdlc/test.log";

export type TestRunRequest = {
  profile: StackProfile;
  /** Every file of the application, as the Workspace holds it. */
  files: readonly TemplateFile[];
};

/** What the Test Run did, for its Issue Report and the dashboard. */
export type TestRunEvidence = {
  operationId: string;
  exitCode: number | null;
  timedOut: boolean;
  durationSeconds: number | null;
  cost: number | null;
  /** The end of the test script's log. */
  log: string;
  /** Files that differ from the Base Snapshot, so they were uploaded. */
  changedFiles: string[];
  /** Template files the application no longer has. */
  removedFiles: string[];
  /** Secret files that were kept out of the sandbox. */
  withheldFiles: string[];
};

export type TestRunOutcome =
  | {
      /** The script finished; `result` says which steps and tests failed. */
      status: "passed" | "failed";
      result: TestScriptResult;
      evidence: TestRunEvidence;
    }
  | {
      /** The script did not report a result: it crashed, hung or was cut off. */
      status: "broken";
      problem: string;
      evidence: TestRunEvidence;
    };

/** Runs an application's tests in the sandbox. */
export interface TestRunner {
  /**
   * Rejects only when the sandbox itself cannot be used (the API is down, the
   * Base Snapshot cannot be built); a failing application is an outcome.
   */
  runTests: (request: TestRunRequest) => Promise<TestRunOutcome>;
}

export type SandboxTestRunnerOptions = {
  sandbox: SandboxClient;
  snapshots: BaseSnapshots;
  /** Content already uploaded, by sha256; shared with the Base Snapshots. */
  uploaded?: Map<string, string>;
  /** What the Base Snapshot holds. Defaults to the template in this repo. */
  files?: (profile: StackProfile) => TemplateFile[];
};

export class SandboxTestRunner implements TestRunner {
  #sandbox: SandboxClient;
  #snapshots: BaseSnapshots;
  #uploaded: Map<string, string>;
  #files: (profile: StackProfile) => TemplateFile[];

  constructor(options: SandboxTestRunnerOptions) {
    this.#sandbox = options.sandbox;
    this.#snapshots = options.snapshots;
    this.#uploaded = options.uploaded ?? new Map();
    this.#files = options.files ?? templateFiles;
  }

  runTests = async ({
    profile,
    files,
  }: TestRunRequest): Promise<TestRunOutcome> => {
    const plan = planUpload(files, this.#files(profile));
    let result: RunResult;
    try {
      result = await this.#run(profile, plan);
    } catch (error) {
      if (!isRejectedRequest(error)) throw error;
      // The sandbox refused the run itself, most likely because the Snapshot's
      // image (or an uploaded file) has expired: start over from scratch, once.
      this.#snapshots.discardSnapshot(profile);
      this.#uploaded.clear();
      result = await this.#run(profile, plan);
    }
    return toOutcome(result, plan);
  };

  async #run(profile: StackProfile, plan: UploadPlan): Promise<RunResult> {
    const image = await this.#snapshots.snapshotImage(profile);
    return this.#sandbox.run(
      {
        image,
        command: testCommand(profile, plan.removed),
        shell: true,
        files: await uploadFiles(this.#sandbox, plan.changed, this.#uploaded),
        timeout: TEST_RUN_TIMEOUT_SECONDS,
        disposable: true,
      },
      { pollMs: POLL_MS, timeoutMs: (TEST_RUN_TIMEOUT_SECONDS + 120) * 1000 },
    );
  }
}

type UploadPlan = {
  changed: TemplateFile[];
  removed: string[];
  withheld: string[];
};

/** Which files differ from the Base Snapshot, and which it has but the app does not. */
export function planUpload(
  files: readonly TemplateFile[],
  snapshotFiles: readonly TemplateFile[],
): UploadPlan {
  const withheld = files.filter((file) => isSecretFile(file.path));
  const kept = files.filter((file) => !isSecretFile(file.path));
  for (const file of kept) assertAppPath(file.path);
  const inSnapshot = new Map(
    snapshotFiles.map((file) => [file.path, sha256(file.contents)]),
  );
  const paths = new Set(kept.map((file) => file.path));
  return {
    changed: kept.filter(
      (file) => inSnapshot.get(file.path) !== sha256(file.contents),
    ),
    removed: [...inSnapshot.keys()].filter((path) => !paths.has(path)),
    withheld: withheld.map((file) => file.path),
  };
}

/**
 * The script's log goes to a file and only its end is printed, so however
 * much the install and tests print, the SDLC_RESULT line is in the output.
 */
export function testCommand(profile: StackProfile, removed: readonly string[]) {
  return [
    `cd ${shellQuote(SANDBOX_APP_DIR)}`,
    ...(removed.length > 0
      ? [`rm -f -- ${removed.map(shellQuote).join(" ")}`]
      : []),
    "mkdir -p .sdlc",
    `{ ${profile.testCommand} > ${LOG_FILE} 2>&1; code=$?; tail -c ${LOG_TAIL_BYTES} ${LOG_FILE}; exit $code; }`,
  ].join(" && ");
}

/** A 4xx other than rate limiting: the API understood and refused the request. */
function isRejectedRequest(error: unknown): boolean {
  return (
    error instanceof SandboxApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  );
}

function toOutcome(result: RunResult, plan: UploadPlan): TestRunOutcome {
  const evidence: TestRunEvidence = {
    operationId: result.operationId,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationSeconds: result.durationSeconds,
    cost: result.cost,
    log: `${result.stdout}${result.stderr}`,
    changedFiles: plan.changed.map((file) => file.path),
    removedFiles: plan.removed,
    withheldFiles: plan.withheld,
  };
  const parsed = parseTestScriptOutput(result.stdout);
  if ("problem" in parsed)
    return {
      status: "broken",
      problem: `${parsed.problem} The sandbox run: ${describeRun(result).split("\n")[0]}.`,
      evidence,
    };
  const { result: script } = parsed;
  // The script's verdict and its exit code must agree; a run that reported
  // success and then failed is not a pass.
  if (script.passed && !commandSucceeded(result))
    return {
      status: "broken",
      problem: `The test script reported success, but the sandbox run did not succeed: ${describeRun(result).split("\n")[0]}.`,
      evidence,
    };
  return {
    status: script.passed ? "passed" : "failed",
    result: script,
    evidence,
  };
}
