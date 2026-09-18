/** Prints which Sandbox permissions the configured key has. Run: pnpm whoami */
const response = await fetch(`${process.env.NEBIUS_SANDBOX_URL ?? "https://api.tokenfactory.nebius.com/sandboxes/v1"}/whoami`, {
  headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}`, Project: `${process.env.NEBIUS_AI_PROJECT}` },
});
const body = (await response.json()) as { permissions?: Record<string, boolean>; limits?: Record<string, number> };
console.log(JSON.stringify({ status: response.status, permissions: body.permissions, limits: body.limits }, null, 2));
