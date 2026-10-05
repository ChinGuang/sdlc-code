// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from "react";
import { RUNS_HREF } from "./router.js";

/**
 * The sidebar and top bar every screen shares. The Connections card shows only
 * what the dashboard can know: whether the local server answers. The server
 * checks its own keys when a Run starts, and says which one is missing.
 */
export function Layout({
  title,
  serverUp,
  onRuns,
  topbar,
  children,
}: {
  title: string;
  /** null while the first check is in flight. */
  serverUp: boolean | null;
  /** Whether this is the Runs screen, which the sidebar marks as current. */
  onRuns: boolean;
  topbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">
          <span className="logo-mark" aria-hidden="true" />
          sdlc-code
        </div>
        <nav className="nav" aria-label="Main">
          <a href={RUNS_HREF} aria-current={onRuns ? "page" : undefined}>
            Runs
          </a>
          <a href="#new-run">New run</a>
        </nav>
        <div className="connections">
          <h2>Connections</h2>
          <div>
            <span
              className={`dot ${serverUp === null ? "" : serverUp ? "green" : "red"}`}
            />
            {serverUp === false ? "Local server not answering" : "Local server"}
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="title">{title}</span>
          {topbar}
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
