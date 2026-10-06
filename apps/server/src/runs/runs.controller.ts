// SPDX-License-Identifier: MPL-2.0
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
 *   GET  /runs/:id/export         the code as of the last Slice Commit, as a zip
 *   POST /runs/:id/abort          abort at an Escalation, with or without a Draft PR
 *   GET  /runs/:id/events         SSE; ?after=<seq>, or the Last-Event-ID a
 *                                 browser sends when it reconnects, replays
 *                                 what the client missed. A "ping" event
 *                                 every few seconds says the stream is alive.
 *
 * A decision answers at once with the Run as it now stands; what the Run does
 * next arrives on the stream.
 */
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  type MessageEvent,
  Param,
  Post,
  Query,
  Sse,
  StreamableFile,
} from "@nestjs/common";
import { interval, map, merge, type Observable } from "rxjs";
import {
  AbortBody,
  DesignGateBody,
  DocumentKindParam,
  ScreenshotParams,
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

/**
 * How often a stream says it is alive. A proxy (the dashboard's dev server)
 * leaves a stream open after the server behind it has gone, and the browser
 * hears no error; a page that hears no ping for a while opens it again (T25c).
 */
export const EVENT_HEARTBEAT_MS = Symbol("EVENT_HEARTBEAT_MS");
export const DEFAULT_HEARTBEAT_MS = 15_000;

@Controller("runs")
export class RunsController {
  #runs: RunService;
  #heartbeatMs: number;

  constructor(
    @Inject(RUN_SERVICE) runs: RunService,
    @Inject(EVENT_HEARTBEAT_MS) heartbeatMs: number,
  ) {
    this.#runs = runs;
    this.#heartbeatMs = heartbeatMs;
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

  /**
   * An image a browser shows as it is: a PNG or JPEG, never JSON. It opens in
   * a tab on this origin, so nothing in it may run: no sniffing, no scripts.
   * A version can be drawn again, so it is kept for minutes, not for ever.
   */
  @Get(":id/screenshots/:version/:order")
  @Header("X-Content-Type-Options", "nosniff")
  @Header("Content-Security-Policy", "default-src 'none'")
  @Header("Cache-Control", "private, max-age=300")
  screenshot(
    @Param("id") id: string,
    @Param("version") version: string,
    @Param("order") order: string,
  ): StreamableFile {
    const wanted = parse(ScreenshotParams, { version, order });
    const image = this.#runs.getScreenshot(id, wanted.version, wanted.order);
    return new StreamableFile(image.bytes, { type: image.mimeType });
  }

  /**
   * The Run's code as of its last Slice Commit, as a zip (S3). The only way
   * out for a Run with no Target Repo, and a copy for one with.
   */
  @Get(":id/export")
  @Header("X-Content-Type-Options", "nosniff")
  @Header("Cache-Control", "no-store")
  async exportCode(@Param("id") id: string): Promise<StreamableFile> {
    const { bytes, filename } = await this.#runs.exportCode(id);
    return new StreamableFile(bytes, {
      type: "application/zip",
      disposition: `attachment; filename="${filename}"`,
    });
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
    // Nest numbers a message that has no id itself, which would move the
    // browser's Last-Event-ID; so a ping repeats the id of the last real event.
    let lastId = Number.isInteger(from) ? String(from) : "0";
    const events = this.#runs
      .events(id, Number.isInteger(from) ? from : undefined)
      .pipe(
        map((event) => {
          lastId = String(event.seq);
          return { id: lastId, type: event.type, data: event };
        }),
      );
    const pings = interval(this.#heartbeatMs).pipe(
      map((): MessageEvent => ({ id: lastId, type: "ping", data: {} })),
    );
    return merge(events, pings);
  }
}
