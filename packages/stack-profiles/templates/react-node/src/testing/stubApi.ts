import { vi } from "vitest";

/**
 * Faking the API for a screen test. Kept apart from the render helpers
 * (screens.tsx re-exports all of it) because testSetup.ts imports it for every
 * test, and must not load the App and every screen with it.
 */

/** What a stubbed endpoint answers: a status (200 unless said) and a JSON body. */
export type StubAnswer = { status?: number; body?: unknown };

/** A stubbed endpoint's reply; `pending` never answers, to test "loading". */
export type StubReply =
  | StubAnswer
  | "pending"
  | ((call: ApiCall) => StubAnswer | "pending");

/** A request the screen made, with the path as the API Contract writes it. */
export type ApiCall = { method: string; path: string; body: unknown };

/** Requests a screen made that nothing stubbed; they fail the test when it ends. */
const unstubbed: string[] = [];

/**
 * Answers the screen's requests from a table: "GET /todos", "PATCH /todos/1".
 * Paths are the API Contract's, without the /api prefix the app adds, and with
 * the query string if there is one ("GET /todos?done=true"). A request nothing
 * answers rejects with the table, and fails the test when it ends even if the
 * screen caught the error and showed its own. Returns the calls made, in order.
 *
 * A reply that is a function sees the call, so it can answer differently each
 * time (a list refetched after a delete) or echo what was sent (a PATCH).
 */
export function stubApi(replies: Record<string, StubReply>): {
  calls: ApiCall[];
} {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request ? request.url : String(input),
        "http://localhost",
      );
      const path =
        url.pathname.replace(/^\/api(?=\/|$)/, "").replace(/(.)\/$/, "$1") +
        url.search;
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      const call: ApiCall = {
        method,
        path,
        body: await sentBody(init?.body, request),
      };
      calls.push(call);
      const reply = replies[`${method} ${path}`];
      if (reply === undefined) {
        const message = `No stub for ${method} ${path}. Stubbed: ${Object.keys(replies).join(", ") || "nothing"}`;
        unstubbed.push(message);
        throw new Error(message);
      }
      const answer = typeof reply === "function" ? reply(call) : reply;
      if (answer === "pending") return new Promise<Response>(() => {});
      return new Response(
        answer.body === undefined ? null : JSON.stringify(answer.body),
        { status: answer.status ?? 200 },
      );
    }),
  );
  return { calls };
}

/** What the request carried: its JSON, else its text, else nothing. */
async function sentBody(
  body: BodyInit | null | undefined,
  request: Request | null,
): Promise<unknown> {
  const text =
    typeof body === "string"
      ? body
      : request
        ? await request.clone().text()
        : null;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The requests that nothing stubbed, and forgets them. A test that means to
 * make one asks for them here; any left at the end fail it (testSetup.ts).
 */
export function expectUnstubbed(): string[] {
  return unstubbed.splice(0);
}

/** Fails the test that just ended if its screen asked for something unstubbed. */
export function verifyStubs(): void {
  const missed = unstubbed.splice(0);
  if (missed.length > 0)
    throw new Error(
      `The screen made requests nothing stubbed:\n${missed.join("\n")}`,
    );
}

/** Answers window.confirm, for a screen that asks before it deletes. */
export function stubConfirm(answer: boolean) {
  const confirm = vi.fn(() => answer);
  vi.stubGlobal("confirm", confirm);
  return confirm;
}
