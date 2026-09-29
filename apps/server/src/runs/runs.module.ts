/**
 * The Runs API and what it runs on (T21). The runtime is made the first time a
 * Run needs it, not at boot: a server started without its keys still answers
 * /health and says, with a 503, what is missing.
 *
 * On start it picks up every Run it was working on when it last stopped
 * (diagram 9), so closing a laptop mid-Run costs the Step in flight and no more.
 * That is also why stopping the server does not wait for Runs to finish: a Step
 * can take minutes, and the next start redoes it anyway.
 */
import {
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { createRunRuntime, type RunRuntime } from "@sdlc-code/core";
import { join } from "node:path";
import { MemoryEventLog } from "./eventLog.js";
import { RunErrorsFilter } from "./runErrors.filter.js";
import { RUN_SERVICE, RuntimeUnavailableError } from "./runService.js";
import { RunsController } from "./runs.controller.js";
import { RuntimeRunService } from "./runtimeRunService.js";

/** Where Runs live unless SDLC_DATA_DIR says otherwise; git-ignored. */
const DEFAULT_DATA_DIR = join(process.cwd(), ".sdlc-runs");

export function runtimeRunService(
  env: Record<string, string | undefined>,
): RuntimeRunService {
  const log = new MemoryEventLog();
  let runtime: RunRuntime | null = null;
  return new RuntimeRunService({
    log,
    runtime: () => {
      if (runtime) return runtime;
      try {
        runtime = createRunRuntime({
          dataDir: env.SDLC_DATA_DIR || DEFAULT_DATA_DIR,
          env,
          events: {
            run: (event) => log.publish(event),
            // One tab serves every Run, so every Run's followers are told.
            penpot: (event) => {
              for (const run of runtime?.runs.listUnfinishedRuns() ?? [])
                log.publish({
                  runId: run.id,
                  type: "problem",
                  problem: `Penpot needs you (${event.kind}): open or click the Penpot tab. Waiting ${event.delayMs / 1000}s, attempt ${event.attempt}.`,
                });
            },
          },
        });
        return runtime;
      } catch (error) {
        throw new RuntimeUnavailableError(
          `The server cannot run anything yet: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}

@Module({
  controllers: [RunsController],
  providers: [
    { provide: RUN_SERVICE, useFactory: () => runtimeRunService(process.env) },
    { provide: APP_FILTER, useClass: RunErrorsFilter },
  ],
})
export class RunsModule implements OnApplicationBootstrap {
  #runs: RuntimeRunService;
  #logger = new Logger("Runs");

  constructor(@Inject(RUN_SERVICE) runs: RuntimeRunService) {
    this.#runs = runs;
  }

  onApplicationBootstrap = async (): Promise<void> => {
    // Only a real service resumes; a test's fake has nothing to pick up.
    if (!(this.#runs instanceof RuntimeRunService)) return;
    try {
      const resumed = await this.#runs.resumeUnfinished();
      if (resumed.length > 0)
        this.#logger.log(`Resumed ${resumed.length} unfinished Run(s).`);
    } catch (error) {
      // No keys yet is not a reason to refuse to start; the first request says so.
      this.#logger.warn(
        `Not resuming unfinished Runs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}
