/**
 * The Runs API (T21): start and list Runs, read one, answer its Gates and its
 * Escalation, and follow what it does as a stream of Server-Sent Events.
 *
 *   POST /runs                    start a Run; it advances in the background
 *   GET  /runs                    every Run, newest first
 *   GET  /runs/:id                one Run, and what it is waiting for
 *   POST /runs/:id/design-gate    Verdicts on the documents in review
 *   POST /runs/:id/escalation     one of the four choices
 *   POST /runs/:id/pr-gate        approve, or request changes
 *   POST /runs/:id/abort          abort at an Escalation, with or without a Draft PR
 *   GET  /runs/:id/events         SSE; ?after=<seq> replays what a client missed
 *
 * A decision answers at once with the Run as it now stands; what the Run does
 * next arrives on the stream.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Sse,
  type MessageEvent,
} from "@nestjs/common";
import { map, type Observable } from "rxjs";
import {
  AbortBody,
  DesignGateBody,
  EscalationBody,
  PullRequestGateBody,
  StartRunBody,
} from "./requests.js";
import {
  RUN_SERVICE,
  RunConflictError,
  type RunDetail,
  type RunService,
  type RunSummary,
} from "./runService.js";
import { parse } from "./parse.js";

@Controller("runs")
export class RunsController {
  #runs: RunService;

  constructor(@Inject(RUN_SERVICE) runs: RunService) {
    this.#runs = runs;
  }

  @Post()
  async start(@Body() body: unknown): Promise<RunSummary> {
    return this.#runs.startRun(parse(StartRunBody, body));
  }

  @Get()
  list(): RunSummary[] {
    return this.#runs.listRuns();
  }

  @Get(":id")
  get(@Param("id") id: string): RunDetail {
    return this.#runs.getRun(id);
  }

  @Post(":id/design-gate")
  @HttpCode(200)
  designGate(@Param("id") id: string, @Body() body: unknown): RunDetail {
    return this.#runs.decideDesign(id, parse(DesignGateBody, body).verdicts);
  }

  @Post(":id/escalation")
  @HttpCode(200)
  escalation(@Param("id") id: string, @Body() body: unknown): RunDetail {
    return this.#runs.resolveEscalation(id, parse(EscalationBody, body));
  }

  @Post(":id/pr-gate")
  @HttpCode(200)
  prGate(@Param("id") id: string, @Body() body: unknown): RunDetail {
    return this.#runs.decidePullRequest(id, parse(PullRequestGateBody, body));
  }

  /**
   * Aborting is an Escalation's choice (CONTEXT.md): a Run that is building has
   * nothing to abort from yet, so this answers 409 until it asks a person.
   */
  @Post(":id/abort")
  @HttpCode(200)
  abort(@Param("id") id: string, @Body() body: unknown): RunDetail {
    const { openDraftPr } = parse(AbortBody, body ?? {});
    if (this.#runs.getRun(id).waiting.for !== "escalation")
      throw new RunConflictError(
        `Run ${id} is not at an Escalation; a Run is aborted from one.`,
      );
    return this.#runs.resolveEscalation(id, {
      choice: "abort",
      openDraftPrOnAbort: openDraftPr,
    });
  }

  @Sse(":id/events")
  events(
    @Param("id") id: string,
    @Query("after") after?: string,
  ): Observable<MessageEvent> {
    const from = after === undefined ? undefined : Number(after);
    return this.#runs
      .events(id, Number.isInteger(from) ? from : undefined)
      .pipe(
        map((event) => ({
          id: String(event.seq),
          type: event.type,
          data: event,
        })),
      );
  }
}
