/**
 * Two screens need no router library: the page is picked from the URL's hash,
 * so it works when Vite or any static server serves index.html, and a link to
 * a Run can be shared or reloaded.
 */
import { useEffect, useState } from "react";

export type Route = { page: "runs" } | { page: "run"; runId: string };

export function parseRoute(hash: string): Route {
  const match = /^#\/runs\/([^/?#]+)/.exec(hash);
  return match
    ? { page: "run", runId: decodeURIComponent(match[1]!) }
    : { page: "runs" };
}

export const runHref = (runId: string) => `#/runs/${encodeURIComponent(runId)}`;
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
