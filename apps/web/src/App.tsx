// SPDX-License-Identifier: MPL-2.0
import { useEffect, useMemo, useState } from "react";
import { HttpRunsApi, type RunsApi } from "./api/client.js";
import { Layout } from "./Layout.js";
import { RunPage } from "./pages/RunPage.js";
import { RunsPage } from "./pages/RunsPage.js";
import { SignIn } from "./pages/SignIn.js";
import { useRoute } from "./router.js";

/** The dashboard, from the Penpot file "sdlc-code dashboard". */
export function App({ api: given }: { api?: RunsApi }) {
  // Null until the server has said whether it wants a token (S2).
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const api = useMemo(
    () =>
      given ?? new HttpRunsApi({ onUnauthorized: () => setSignedIn(false) }),
    [given],
  );
  const route = useRoute();
  const [search, setSearch] = useState("");
  const [serverUp, setServerUp] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void api.serverUp().then((up) => live && setServerUp(up));
    void api.session().then((s) => live && setSignedIn(s.signedIn));
    return () => {
      live = false;
    };
  }, [api]);

  // Nothing of the Runs is asked for until the server has said it may be.
  if (signedIn === null)
    return (
      <Layout title="Runs" serverUp={serverUp} onRuns>
        <p className="muted">Connecting…</p>
      </Layout>
    );
  if (signedIn === false)
    return (
      <Layout title="Sign in" serverUp={serverUp} onRuns={false}>
        <SignIn api={api} onSignedIn={() => setSignedIn(true)} />
      </Layout>
    );
  if (route.page === "run")
    return (
      <Layout title="Run" serverUp={serverUp} onRuns={false}>
        <RunPage
          key={route.runId}
          api={api}
          runId={route.runId}
          tab={route.tab}
        />
      </Layout>
    );
  return (
    <Layout
      title="Runs"
      serverUp={serverUp}
      onRuns
      topbar={
        <input
          className="search"
          type="search"
          aria-label="Search runs"
          placeholder="Search runs…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      }
    >
      <RunsPage api={api} search={search} />
    </Layout>
  );
}
