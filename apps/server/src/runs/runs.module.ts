/**
 * The Runs API and what it runs on (T21). The runtime is made the first time a
 * Run needs it, not at boot: a server started without its keys still answers
 * /health and says, with a 503, what is missing.
 *
 * On start it picks up every Run it was working on when it last stopped
 * (diagram 9), so closing a laptop mid-Run costs the Step in flight and no more.
 * On stop it closes what it opened and does not wait for Runs, because a Step
 * can take minutes and the next start redoes it anyway.
 */
import {
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import {
  createRunRuntime,
  MissingKeyError,
  type RunRuntime,
} from "@sdlc-code/core";
import { fileURLToPath } from "node:url";
import { MemoryEventLog } from "./eventLog.js";
import { RunErrorsFilter } from "./runErrors.filter.js";
import {
  RUN_LIFECYCLE,
  RUN_SERVICE,
  RuntimeUnavailableError,
  type RunLifecycle,
} from "./runService.js";
import {
  DEFAULT_HEARTBEAT_MS,
  EVENT_HEARTBEAT_MS,
  RunsController,
} from "./runs.controller.js";
import { RuntimeRunService } from "./runtimeRunService.js";

/**
 * The repository root, where the terminal script keeps its Runs too: the
 * server started from apps/server must see the same Runs and the same agent
 * config, not a second, empty set of its own.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export function runtimeRunService(
  env: Record<string, string | undefined>,
): RuntimeRunService {
  const log = new MemoryEventLog();
  let runtime: RunRuntime | null = null;
  const make = (): RunRuntime => {
    if (runtime) return runtime;
    try {
      // Nothing is opened until every key is found, so trying again on the
      // next request after a failure leaks nothing.
      runtime = createRunRuntime({
        dataDir: env.SDLC_DATA_DIR || `${REPO_ROOT}.sdlc-runs`,
        configPath: `${REPO_ROOT}sdlc-code.config.json`,
        env,
        events: {
          run: (event) => log.publish(event),
          // One tab serves every Run, so every Run that is working is told;
          // one waiting at a Gate is not drawing and does not need to hear it.
          penpot: (event) => {
            for (const run of runtime?.runs.listUnfinishedRuns() ?? [])
              if (!WAITING_FOR_A_PERSON.has(run.status))
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
      if (error instanceof MissingKeyError)
        throw new RuntimeUnavailableError(
          `The server cannot run anything yet: ${error.message}`,
        );
      throw error;
    }
  };
  return new RuntimeRunService({ log, runtime: make, made: () => !!runtime });
}

const WAITING_FOR_A_PERSON = new Set([
  "awaitingDesignGate",
  "escalated",
  "awaitingPrGate",
]);

@Module({
  controllers: [RunsController],
  providers: [
    { provide: RUN_SERVICE, useFactory: () => runtimeRunService(process.env) },
    // The same object: it serves requests and is started and stopped.
    { provide: RUN_LIFECYCLE, useExisting: RUN_SERVICE },
    { provide: APP_FILTER, useClass: RunErrorsFilter },
    { provide: EVENT_HEARTBEAT_MS, useValue: DEFAULT_HEARTBEAT_MS },
  ],
})
export class RunsModule
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  #lifecycle: RunLifecycle;
  #logger = new Logger("Runs");

  constructor(@Inject(RUN_LIFECYCLE) lifecycle: RunLifecycle) {
    this.#lifecycle = lifecycle;
  }

  onApplicationBootstrap = async (): Promise<void> => {
    try {
      const { resumed, failed } = await this.#lifecycle.resumeUnfinished();
      if (resumed.length > 0)
        this.#logger.log(`Resumed ${resumed.length} unfinished Run(s).`);
      for (const { runId, problem } of failed)
        this.#logger.warn(`Could not resume Run ${runId}: ${problem}`);
    } catch (error) {
      // No keys yet is not a reason to refuse to start; the first request says so.
      this.#logger.warn(
        `Not resuming unfinished Runs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  onApplicationShutdown = async (): Promise<void> => {
    await this.#lifecycle.shutdown();
  };
}
