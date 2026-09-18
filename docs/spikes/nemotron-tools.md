# Spike T03 — Nemotron tool calling on Token Factory

- **Date:** 2026-09-18
- **Code:** [`spikes/t03-nemotron-tools`](../../spikes/t03-nemotron-tools) — `chatClient.ts` (tested `TokenFactoryChatClient`), `toolLoop.ts` (tested `ChatToolLoop`), `probe.ts` (live probe), `models.ts` (model listing)
- **Result:** ✅ All four NVIDIA Nemotron models on Token Factory do OpenAI-style tool calling and JSON-schema output. **0 malformed tool arguments in 397 tool calls across 38 runs.** The big difference between models is **parallel tool calls**, which drives cost and latency more than per-token price.

## Models available to our key

From `GET /v1/models?verbose=true` (`pnpm models`). Use these **exact** ids — they are case-sensitive in the listing (`Nemotron-3-Ultra…` vs `nemotron-3-super…`).

| Model id | Context | $ / 1M in → out | Limits (RPM / TPM) | Features |
|---|---|---|---|---|
| `nvidia/Nemotron-3-Ultra-550b-a55b` | 1M | 1.00 → 3.00 | 300 / 200k | tools, reasoning |
| `nvidia/nemotron-3-super-120b-a12b` | 262k | 0.30 → 0.90 | 300 / 200k | tools, reasoning |
| `nvidia/Nemotron-3_5-Lightning` | 1M | 0.06 → 0.24 | 600 / 400k | tools, reasoning |
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 262k | 0.06 → 0.24 | 100 / 800k | tools, reasoning |

Project-wide default limits also apply (docs: 60 RPM / 400k TPM baseline, auto-scaling up to 20×; HTTP 429 with `Retry-After` when exceeded).

## Experiments

Per model, temperature 0 (`pnpm probe [model…]`, results in gitignored `results/`):

1. **single_tool_call** — "weather in Paris in celsius" with a `get_weather` tool; loop until answer.
2. **forced_tool_choice** — "tell me a joke" with `tool_choice` forcing `get_weather`.
3. **structured_output_slice_plan** — `response_format: json_schema` (schema also in the system prompt) for a Slice Plan.
4. **long_loop_12_files** — `list_files` + `read_file` over 12 files; reply with the sum (needs 13 tool calls). Repeated 5× (`PROBE_ONLY=long_loop PROBE_REPEAT=5`).
5. **long_loop_parallel_hint** — as 4, plus a system-prompt instruction to issue independent calls in parallel (Super, Nano; 3×).
6. **reasoning_off_single_tool_call** — as 1 with `chat_template_kwargs: { enable_thinking: false }`.

## Results

| | Ultra | Super | Lightning | Nano |
|---|---|---|---|---|
| Single tool call | ✅ | ✅ | ✅ | ✅ |
| Forced `tool_choice` | ✅ valid args | ✅ | ✅ | ✅ |
| JSON-schema Slice Plan | ✅ valid, 0 schema problems | ✅ | ✅ | ✅ |
| 12-file loop correct | 6/6 | 6/6 (+3/3 with hint) | 6/6 | **5/6** (+3/3 with hint) |
| Parallel tool calls | **yes** (12 reads in 1 turn) | **never** | **yes** | **never** |
| Turns for 12-file loop | 3 | 14 | 3 | 14 |
| Avg wall time, 12-file loop | 3.9 s | 17.1 s | 2.2 s | 23.8 s |
| Avg prompt / completion tokens | 1,940 / 693 | 12,048 / 795 | 2,243 / 427 | 10,900 / 2,922 |
| Avg cost, 12-file loop | $0.0040 | $0.0043 | $0.00024 | $0.0014 |
| `enable_thinking: false` | accepted; 162 → 53 completion tokens, 2.4 → 1.5 s | accepted; 88 → 68 | accepted (no reasoning emitted anyway) | accepted; 284 → 56, 1.8 → 0.8 s |

(Averages from the 5× repeat run; single-call figures from the first run.)

## Findings

1. **Tool-call format is standard OpenAI.** `message.tool_calls[].function.arguments` is a JSON string; ids look like `chatcmpl-tool-…`; `finish_reason` is `tool_calls`. No malformed arguments and no calls to non-existent tools in 397 calls.
2. **`tool_choice` forcing works** on all four, even when the prompt is unrelated.
3. **JSON-schema output works** on all four when the schema is sent both as `response_format.json_schema` and in the system prompt (Token Factory docs recommend both). Single sample per model — T09 must still validate every response.
4. **Super and Nano never make parallel tool calls**, even when told to. Each call costs a full turn, and every turn resends the whole conversation, so prompt tokens grow roughly with turns²: Super used **6× Ultra's prompt tokens** for the same task and ended up **as expensive as Ultra and 4× slower**, despite a per-token price one third of Ultra's.
5. **Reasoning** comes back in `message.reasoning_content` and is on by default. `chat_template_kwargs: { enable_thinking: false }` is accepted by all four and cuts completion tokens and latency (up to 5× fewer tokens on Nano). Lightning emitted no reasoning for tool calls but ~1.5k reasoning tokens (5 s) for the structured Slice Plan.
6. **Completion can't be trusted blindly.** Nano once read 11 of 12 files and confidently answered a wrong sum. Every other run read all 12. Agents need checks in code, not just in prompts.

## Rules for the agent loop (T08) and agents

1. Use the `TokenFactoryChatClient` / `ChatToolLoop` shapes from this spike; OpenAI-compatible request/response, `reasoning_content` captured into the Transcript.
2. **Prefer batch tools over many small ones** — e.g. `read_files(paths[])` instead of only `read_file(path)` — because Super/Nano will not parallelise. This cuts turns, tokens and time for every model.
3. **Count turns and tokens per Step** and feed them into the Token Budget; keep contexts short (Working Memory instead of long histories) since prompt cost grows with every turn.
4. **Send JSON schemas twice** (in `response_format` and in the prompt) and validate every structured response in code before using it; on failure, retry once with the validation errors.
5. **Verify completion in code** where possible (e.g. "all files in the Slice were read / written", tests actually ran) rather than trusting the model's final message.
6. **Thinking on for judgement, off for mechanics:** keep reasoning on for System Design, Orchestrator decisions and Code Review; consider `enable_thinking: false` for mechanical tool loops (file reads, test runs). Make it a per-role config flag.
7. **Handle 429** with `Retry-After` (surfaced by `ChatApiError.retryAfterSeconds`); per-model limits allow our planned parallelism (2 Coding Agents at once).
8. Use exact model ids from `/v1/models`; don't hard-code lower-cased variants.

## Open decision — model defaults per role

The agreed defaults (grilling Q5) are **Ultra** for Orchestrator / System Design / Code Review and **Super** for Coding / Testing / UI Design. This spike suggests Super is a poor fit for **tool-heavy** roles because it never parallelises: it is no cheaper than Ultra in practice and much slower. Lightning is fast, cheap and parallel, but this spike only tests simple tools, not code quality.

> Options:
> - **(a) Keep defaults now, re-evaluate after T15** with a real coding task (Super vs Lightning vs Ultra on the same Slice).
> - **(b) Switch tool-heavy roles (Coding, Testing, UI Design) to Lightning now**, keep Ultra for reasoning roles, and confirm in T15.
>
> Recommendation: (a) plus rule 2 (batch tools), which removes most of Super's penalty regardless. Model ids are config, so switching later costs nothing.

## Appendix: what the real API returned

Super, first turn of `single_tool_call` (assistant message as appended to the conversation):

```json
{"role":"assistant","content":null,"tool_calls":[{"id":"chatcmpl-tool-b3e3754138a63e9f","type":"function","function":{"name":"get_weather","arguments":"{\"city\": \"Paris\", \"unit\": \"celsius\"}"}}]}
```

Ultra, `forced_tool_choice` ("Tell me a joke." with `get_weather` forced):

```json
[{"id":"chatcmpl-tool-a66e97bfe624ec68","name":"get_weather","arguments":"{\"city\": \"Paris\", \"unit\": \"celsius\"}"}]
```

Super, `structured_output_slice_plan` content:

```json
{"slices": [{"order": 1, "name": "Walking skeleton", "endpoints": ["GET /health", "POST /register", "POST /login", "GET /lists", "POST /lists"]}, {"order": 2, "name": "Auth & Todo core", "endpoints": ["POST /register (real)", "POST /login (JWT)", "GET /me", "GET /lists", "POST /lists", "GET /lists/:id", "PUT /lists/:id", "DELETE /lists/:id", "GET /lists/:id/todos", "POST /lists/:id/todos", "PUT /lists/:id/todos/:todoId", "DELETE /lists/:id/todos/:todoId"]}, {"order": 3, "name": "Shared lists & invites", "endpoints": ["POST /lists/:id/invite", "GET /invites/:token", "POST /invites/:token/accept", "GET /users/:userId/lists"]}]}
```

Note the Walking Skeleton here already includes auth endpoints — schema-valid but not what our Walking Skeleton means (health check + one empty screen). T09's validator and prompt must enforce the definition from CONTEXT.md, not just the JSON shape.

Nano, the one wrong 12-file run: 12 tool calls, 11 distinct files read, final content `"\n2552"` (expected 3018).
