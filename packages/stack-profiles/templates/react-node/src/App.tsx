import { useEffect, useState } from "react";
import { getHealth, type Health } from "./api.js";

/** The Walking Skeleton screen: proves the app reaches its API. */
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((problem: unknown) =>
        setError(problem instanceof Error ? problem.message : String(problem)),
      );
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 p-16 text-slate-100">
      <h1 className="text-4xl font-semibold">App</h1>
      <p className="mt-4 text-slate-400">
        {error ?? (health ? `API ${health.status}, database ${health.database}` : "Checking the API…")}
      </p>
    </main>
  );
}
