/** Lists NVIDIA models visible to the configured key, with any metadata the API returns. Run: pnpm models */
const base = process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1";
if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY missing from sdlc-code/.env");
const res = await fetch(`${base}/models?verbose=true`, { headers: { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}` } });
const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
const nvidia = (body.data ?? []).filter((m) => String(m.id).toLowerCase().includes("nemotron") || String(m.id).startsWith("nvidia/"));
console.log(JSON.stringify({ status: res.status, total: body.data?.length, nvidia }, null, 2));
