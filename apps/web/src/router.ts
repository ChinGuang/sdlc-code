/**
 * A few screens need no router library: the page is picked from the URL's hash,
 * so it works when Vite or any static server serves index.html, and a link to
 * a Run can be shared or reloaded.
 */
import { useEffect, useState } from "react";

/** A Run's tabs: the overview, and a page for each decision a person makes. */
export type RunTab = "overview" | "designGate" | "review";

export type Route =
  { page: "runs" } | { page: "run"; runId: string; tab: RunTab };

const TAB_PATHS: Record<RunTab, string> = {
  overview: "",
  designGate: "/design-gate",
  review: "/review",
};

export function parseRoute(hash: string): Route {
  const match = /^#\/runs\/([^/?#]+)(\/[^?#]*)?/.exec(hash);
  if (!match) return { page: "runs" };
  const tab =
    (Object.keys(TAB_PATHS) as RunTab[]).find(
      (one) => TAB_PATHS[one] === (match[2] ?? ""),
    ) ?? "overview";
  return { page: "run", runId: decodeURIComponent(match[1]!), tab };
}

export const runHref = (runId: string, tab: RunTab = "overview") =>
  `#/runs/${encodeURIComponent(runId)}${TAB_PATHS[tab]}`;
export const RUNS_HREF = "#/runs";

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const follow = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  return route;
}
