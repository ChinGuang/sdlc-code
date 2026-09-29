/**
 * The events every Run has produced since the server started, numbered in the
 * order they happened (T21). A client following a Run reads them as a stream;
 * one that reconnects says the last number it saw and is sent what it missed.
 *
 * Kept in memory and bounded: the database is the record of a Run, and this is
 * only what is happening now.
 */
import type { RuntimeEvent } from "@sdlc-code/core";
import { Observable, Subject } from "rxjs";
import type { StreamedEvent } from "./runService.js";

/** Enough to catch up after a dropped connection, not a history. */
const KEPT_PER_RUN = 500;

export interface EventLog {
  publish: (event: RuntimeEvent) => StreamedEvent;
  /** The Run's events after `after` (none by default), then every new one. */
  follow: (runId: string, after?: number) => Observable<StreamedEvent>;
}

export class MemoryEventLog implements EventLog {
  #seq = 0;
  #kept = new Map<string, StreamedEvent[]>();
  #live = new Subject<StreamedEvent>();
  #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  publish = (event: RuntimeEvent): StreamedEvent => {
    const streamed: StreamedEvent = {
      ...event,
      seq: ++this.#seq,
      happenedAt: this.#now().toISOString(),
    };
    const kept = this.#kept.get(event.runId) ?? [];
    kept.push(streamed);
    if (kept.length > KEPT_PER_RUN) kept.splice(0, kept.length - KEPT_PER_RUN);
    this.#kept.set(event.runId, kept);
    this.#live.next(streamed);
    return streamed;
  };

  follow = (runId: string, after?: number): Observable<StreamedEvent> =>
    new Observable<StreamedEvent>((subscriber) => {
      // Replay and subscribe in one synchronous block: nothing can be published
      // between them, so no event is missed and none is sent twice.
      let lastSent = after ?? this.#seq;
      if (after !== undefined)
        for (const event of this.#kept.get(runId) ?? [])
          if (event.seq > lastSent) {
            lastSent = event.seq;
            subscriber.next(event);
          }
      const live = this.#live.subscribe((event) => {
        if (event.runId !== runId || event.seq <= lastSent) return;
        lastSent = event.seq;
        subscriber.next(event);
      });
      return () => live.unsubscribe();
    });
}
