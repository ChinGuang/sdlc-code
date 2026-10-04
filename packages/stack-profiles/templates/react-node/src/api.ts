/** The only way the app talks to the API (STRUCT-01). */
export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`);
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

/**
 * A write: the body goes as JSON, and a failure (any status but 2xx) throws.
 * What it resolves with is the response's JSON, or nothing for a 204; `T` is
 * `void` for an endpoint that answers 204.
 */
export async function sendJson<T = void>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${method} ${path} failed: ${response.status}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export type Health = { status: "ok" | "degraded"; database: "up" | "down" };

export const getHealth = () => getJson<Health>("/health");
