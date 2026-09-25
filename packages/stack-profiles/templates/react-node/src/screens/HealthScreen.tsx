import { useEffect, useState } from "react";
import { getHealth, type Health } from "../api.js";

/** The Walking Skeleton screen: proves the app reaches its API. */
export function HealthScreen() {
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
    <section>
      <h1 className="text-4xl font-semibold">App</h1>
      <p className="mt-4 text-slate-400">
        {error ??
          (health
            ? `API ${health.status}, database ${health.database}`
            : "Checking the API…")}
      </p>
    </section>
  );
}
