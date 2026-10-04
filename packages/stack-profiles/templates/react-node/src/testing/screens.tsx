import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";

/**
 * Helpers for testing a screen, so a test says what it checks and not how a
 * fetch is faked or a route is mounted. src/testing/screenTests.example.test.tsx
 * is a worked example of every one of them: copy it.
 */

/** What a stubbed endpoint answers; `pending` never answers, to test "loading". */
export type StubReply =
  | { status?: number; body?: unknown }
  | "pending"
  | ((call: ApiCall) => { status?: number; body?: unknown } | "pending");

/** A request the screen made, with the path as the API Contract writes it. */
export type ApiCall = { method: string; path: string; body: unknown };

/**
 * Answers the screen's requests from a table: "GET /todos", "PATCH /todos/1".
 * Paths are the API Contract's, without the /api prefix the app adds. A
 * request nothing answers fails the test with the table, so a typo is seen.
 * Returns the calls made, in order.
 */
export function stubApi(replies: Record<string, StubReply>): {
  calls: ApiCall[];
} {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url).replace(/^\/api(?=\/)/, "");
      const method = (init?.method ?? "GET").toUpperCase();
      const call: ApiCall = {
        method,
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const reply = replies[`${method} ${path}`];
      if (reply === undefined)
        throw new Error(
          `No stub for ${method} ${path}. Stubbed: ${Object.keys(replies).join(", ") || "nothing"}`,
        );
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

/** Shows where the router is, so a test sees a navigation without faking it. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

/**
 * Renders a screen on its own route, as App does: `route` is the Route's path
 * ("/edit/:id", so useParams works) and `at` the address it is opened at
 * ("/edit/1"). Where the router is now is `currentPath()`; never fake
 * useNavigate, move to another route and look.
 */
export function renderRoute(
  element: ReactElement,
  { route = "/", at = route }: { route?: string; at?: string } = {},
): void {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path={route} element={element} />
        <Route path="*" element={null} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** The router's current path, e.g. "/" after a screen navigated home. */
export function currentPath(): string {
  return screen.getByTestId("location").textContent ?? "";
}

/** Types into the field with this label, as a person does. */
export function typeInto(label: string | RegExp, text: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
}

/** Presses the button with this name; a submit button submits its form. */
export function press(name: string | RegExp): void {
  fireEvent.click(screen.getByRole("button", { name }));
}
