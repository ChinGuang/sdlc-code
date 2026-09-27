/**
 * Lint Runs (T19): the linters of diagram 8, step 1, run in the sandbox on the
 * Slice Commits. It is a Test Run's shape — start from the Stack Profile's Base
 * Snapshot, upload only what differs, run one script — because it is the same
 * job with a different script: the sandbox executes, the Workspace holds the
 * files (ADR 0001).
 *
 * The linters' complaints are not Findings yet. What Rule each cites, and how
 * serious it is, is the layered Review Standard's to say (linterFindings.ts).
 */
import {
  commandSucceeded,
  SandboxApiError,
  type RunResult,
  type SandboxClient,
} from "@sdlc-code/clients";
import {
  parseLintScriptOutput,
  templateFiles,
  type LintScriptResult,
  type StackProfile,
  type TemplateFile,
} from "@sdlc-code/stack-profiles";
import { describeRun, type BaseSnapshots } from "./baseSnapshots.js";
import { planUpload, type TestRunEvidence } from "./testRunner.js";
import {
  SANDBOX_APP_DIR,
  shellQuote,
  uploadFiles,
  type UploadCache,
} from "./sandboxFiles.js";

/**
 * Shorter than a Test Run's: the linters do not install, boot or wait for a
 * port, so anything past this is a hung tool.
 */
const LINT_RUN_TIMEOUT_SECONDS = 600;
const POLL_MS = 250;
const LOG_TAIL_BYTES = 60_000;
const LOG_FILE = ".sdlc/lint.log";

export type LintRunRequest = {
  profile: StackProfile;
  /** Every file of the application, as the Workspace holds it. */
  files: readonly TemplateFile[];
};

export type LintRunOutcome =
  | {
      /** The script ran; `result` says what each tool found, which may be nothing. */
      status: "linted";
      result: LintScriptResult;
      evidence: TestRunEvidence;
    }
  | {
      /** No result line: the script crashed, hung or was cut off. */
      status: "broken";
      problem: string;
      evidence: TestRunEvidence;
    };

/** Runs an application's linters in the sandbox. */
export interface LintRunner {
  /**
   * Rejects only when the sandbox itself cannot be used; a linter that found
   * problems, or a tool that failed to run, is an outcome.
   */
  runLinters: (request: LintRunRequest) => Promise<LintRunOutcome>;
}

export type SandboxLintRunnerOptions = {
  sandbox: SandboxClient;
  snapshots: BaseSnapshots;
  /** Content already uploaded, by sha256; shared with the Test Runs. */
  uploaded?: UploadCache;
  /** What the Base Snapshot holds. Defaults to the template in this repo. */
  files?: (profile: StackProfile) => TemplateFile[];
};

export class SandboxLintRunner implements LintRunner {
  #sandbox: SandboxClient;
  #snapshots: BaseSnapshots;
  #uploaded: UploadCache;
  #files: (profile: StackProfile) => TemplateFile[];

  constructor(options: SandboxLintRunnerOptions) {
    this.#sandbox = options.sandbox;
    this.#snapshots = options.snapshots;
    this.#uploaded = options.uploaded ?? new Map();
    this.#files = options.files ?? templateFiles;
  }

  runLinters = async ({
    profile,
    files,
  }: LintRunRequest): Promise<LintRunOutcome> => {
    const plan = planUpload(files, this.#files(profile));
    let result: RunResult;
    try {
      result = await this.#run(profile, plan);
    } catch (error) {
      if (!isGone(error)) throw error;
      // The Snapshot's image or an uploaded file has expired: start over once,
      // as a Test Run does.
      this.#snapshots.discardSnapshot(profile);
      this.#uploaded.clear();
      result = await this.#run(profile, plan);
    }
    return toOutcome(result, plan);
  };

  async #run(
    profile: StackProfile,
    plan: ReturnType<typeof planUpload>,
  ): Promise<RunResult> {
    const image = await this.#snapshots.snapshotImage(profile);
    return this.#sandbox.run(
      {
        image,
        command: lintCommand(profile, plan.removed),
        shell: true,
        files: await uploadFiles(this.#sandbox, plan.changed, this.#uploaded),
        timeout: LINT_RUN_TIMEOUT_SECONDS,
        disposable: true,
      },
      { pollMs: POLL_MS, timeoutMs: (LINT_RUN_TIMEOUT_SECONDS + 120) * 1000 },
    );
  }
}

/**
 * The script's log goes to a file and only its end is printed, so however much
 * the linters print, the SDLC_LINT line is in the output.
 */
export function lintCommand(
  profile: StackProfile,
  removed: readonly string[],
): string {
  return [
    `cd ${shellQuote(SANDBOX_APP_DIR)}`,
    ...(removed.length > 0
      ? [`rm -f -- ${removed.map(shellQuote).join(" ")}`]
      : []),
    "mkdir -p .sdlc",
    `{ ${profile.lintCommand} > ${LOG_FILE} 2>&1; code=$?; tail -c ${LOG_TAIL_BYTES} ${LOG_FILE}; exit $code; }`,
  ].join(" && ");
}

/** The API no longer has something the run named. */
function isGone(error: unknown): boolean {
  return (
    error instanceof SandboxApiError &&
    (error.status === 404 || error.status === 410)
  );
}

function toOutcome(
  result: RunResult,
  plan: ReturnType<typeof planUpload>,
): LintRunOutcome {
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
  const parsed = parseLintScriptOutput(result.stdout);
  if ("problem" in parsed)
    return {
      status: "broken",
      problem: `${parsed.problem} The sandbox run: ${describeRun(result).split("\n")[0]}.`,
      evidence,
    };
  // A linter that finds nothing exits 0, and one that finds problems does not,
  // so only an exit code with no result at all means the run itself broke.
  const clean = parsed.result.problems.length === 0;
  if (clean && !commandSucceeded(result))
    return {
      status: "broken",
      problem: `The lint script reported nothing, but the sandbox run did not succeed: ${describeRun(result).split("\n")[0]}.`,
      evidence,
    };
  return { status: "linted", result: parsed.result, evidence };
}
