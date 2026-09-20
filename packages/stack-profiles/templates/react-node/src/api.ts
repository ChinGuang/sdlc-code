/** The only way the app talks to the API (STRUCT-01). */
export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`);
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

export type Health = { status: "ok" | "degraded"; database: "up" | "down" };

export const getHealth = () => getJson<Health>("/health");
