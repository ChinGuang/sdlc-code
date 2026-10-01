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
 *   GET  /runs/:id/events         SSE; ?after=<seq>, or the Last-Event-ID a
 *                                 browser sends when it reconnects, replays
 *                                 what the client missed
 *
 * A decision answers at once with the Run as it now stands; what the Run does
 * next arrives on the stream.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
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
  DocumentKindParam,
  EscalationBody,
  PullRequestGateBody,
  StartRunBody,
} from "./requests.js";
import {
  RUN_SERVICE,
  type DocumentView,
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

  @Get(":id/documents/:kind")
  document(@Param("id") id: string, @Param("kind") kind: string): DocumentView {
    return this.#runs.getDocument(id, parse(DocumentKindParam, kind));
  }

  @Post(":id/retry-design")
  @HttpCode(200)
  retryDesign(@Param("id") id: string): RunDetail {
    return this.#runs.retryDesign(id);
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

  @Post(":id/abort")
  @HttpCode(200)
  abort(@Param("id") id: string, @Body() body: unknown): RunDetail {
    const { openDraftPrOnAbort } = parse(AbortBody, body ?? {});
    return this.#runs.abortRun(id, openDraftPrOnAbort);
  }

  @Sse(":id/events")
  events(
    @Param("id") id: string,
    @Query("after") after?: string,
    @Headers("last-event-id") lastEventId?: string,
  ): Observable<MessageEvent> {
    // A browser's EventSource reconnects on its own to the same URL, ?after
    // and all, and says where it really got to in this header: so the header
    // wins, or every reconnect would replay from the first page load.
    const resumeFrom = lastEventId ?? after;
    const from = resumeFrom === undefined ? undefined : Number(resumeFrom);
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
