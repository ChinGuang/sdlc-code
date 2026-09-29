import { useEffect, useMemo, useState } from "react";
import { HttpRunsApi, type RunsApi } from "./api/client.js";
import { Layout } from "./Layout.js";
import { RunPage } from "./pages/RunPage.js";
import { RunsPage } from "./pages/RunsPage.js";
import { useRoute } from "./router.js";

/** The dashboard, from the Penpot file "sdlc-code dashboard". */
export function App({ api: given }: { api?: RunsApi }) {
  const api = useMemo(() => given ?? new HttpRunsApi(), [given]);
  const route = useRoute();
  const [search, setSearch] = useState("");
  const [serverUp, setServerUp] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void api.serverUp().then((up) => live && setServerUp(up));
    return () => {
      live = false;
    };
  }, [api]);

  if (route.page === "run")
    return (
      <Layout title="Run" serverUp={serverUp}>
        <RunPage api={api} runId={route.runId} />
      </Layout>
    );
  return (
    <Layout
      title="Runs"
      serverUp={serverUp}
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
