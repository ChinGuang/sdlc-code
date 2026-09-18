# Spikes (frozen)

Throwaway code from milestone M0, kept as the evidence behind the spike write-ups in [`docs/spikes`](../docs/spikes). It is **not** part of the pnpm workspace, lint, typecheck or CI, and it is not maintained.

| Spike | Write-up | Maintained code now lives in |
|---|---|---|
| `t01-sandbox` | [sandbox.md](../docs/spikes/sandbox.md) | `packages/clients/src/sandbox` |
| `t02-penpot-mcp` | [penpot-mcp.md](../docs/spikes/penpot-mcp.md) | `packages/clients/src/penpot` |
| `t03-nemotron-tools` | [nemotron-tools.md](../docs/spikes/nemotron-tools.md) | `packages/clients/src/tokenFactory` (tool loop → T08) |

Change the clients in `packages/clients`, not here. Each spike still runs on its own (`pnpm install && pnpm probe` inside its folder).
