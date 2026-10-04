import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { App } from "../App.js";

/**
 * Helpers for testing a screen, so a test says what it checks and not how a
 * fetch is faked or a route is mounted. src/testing/screenTests.example.test.tsx
 * is a worked example of every one of them: copy it. The API stubbing
 * (stubApi, stubConfirm, expectUnstubbed) lives in stubApi.ts and is
 * re-exported here, so a test imports everything from one place.
 */
export {
  expectUnstubbed,
  stubApi,
  stubConfirm,
  type ApiCall,
  type StubAnswer,
  type StubReply,
} from "./stubApi.js";

/**
 * Shows where the router is, for a test and for no one else: it has no text
 * and no role, so no query of a screen's own finds it twice.
 */
function LocationProbe() {
  const location = useLocation();
  return (
    <div
      hidden
      data-testid="location"
      data-path={location.pathname + location.search}
    />
  );
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

/** Renders the whole App, opened at `at`, to test how screens link to each other. */
export function renderApp(at = "/"): void {
  render(
    <MemoryRouter initialEntries={[at]}>
      <App />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** The router's current path and query, e.g. "/" after a screen navigated home. */
export function currentPath(): string {
  return screen.getByTestId("location").getAttribute("data-path") ?? "";
}

/** Types into the field with this label, as a person does. */
export function typeInto(label: string | RegExp, text: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
}

/** Follows the link with this name, as a click does. */
export function follow(name: string | RegExp): void {
  fireEvent.click(screen.getByRole("link", { name }));
}

/** Presses the button with this name; a submit button submits its form. */
export function press(name: string | RegExp): void {
  fireEvent.click(screen.getByRole("button", { name }));
}
