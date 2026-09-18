# Spike T03 — Nemotron tool calling on Token Factory

- **Date:** 2026-09-18
- **Code:** spike code (removed from `main`; kept at commit [`e51a607`](https://github.com/ChinGuang/sdlc-code/tree/e51a607/spikes/t03-nemotron-tools)) — `chatClient.ts`, `toolLoop.ts`, `probe.ts` (live probe), `models.ts`. **Maintained code:** `packages/clients/src/tokenFactory` (`TokenFactoryChatClient`, `listModels`) and `packages/core/src/agentLoop` (`ChatToolLoop`); model listing: `pnpm --filter @sdlc-code/clients models:list`
- **Result:** ✅ All four NVIDIA Nemotron models on Token Factory do OpenAI-style tool calling and JSON-schema output reliably: **0 malformed arguments in 521 tool calls** over 48 tool-using runs, and **16/16 schema-valid** structured outputs. They differ sharply in **parallel tool calls**, **multi-step accuracy** and **long-context recall** — which is what the agent loop has to design around.
- **Spec coverage:** the task asked for Ultra + Super; Lightning and Nano were added because they appeared in the model listing and cost ~nothing to test.

## Models available to our key

From `GET /v1/models?verbose=true` (`pnpm --filter @sdlc-code/clients models:list`). Use these **exact** ids.

| Model id | Context | $ / 1M in → out | Limits (RPM / TPM) | Features |
|---|---|---|---|---|
| `nvidia/Nemotron-3-Ultra-550b-a55b` | 1M | 1.00 → 3.00 | 300 / 200k | tools, reasoning |
| `nvidia/nemotron-3-super-120b-a12b` | 262k | 0.30 → 0.90 | 300 / 200k | tools, reasoning |
| `nvidia/Nemotron-3_5-Lightning` | 1M | 0.06 → 0.24 | 600 / 400k | tools, reasoning |
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 262k | 0.06 → 0.24 | 100 / 800k | tools, reasoning |

Project-wide defaults also apply (docs: 60 RPM / 400k TPM baseline, auto-scaling up to 20×; HTTP 429 with `Retry-After`). **Rate limits were not exercised** — no concurrency and no 429 in this spike.

## Experiments

All at temperature 0 (spike `pnpm probe [model…]` at [`e51a607`](https://github.com/ChinGuang/sdlc-code/tree/e51a607/spikes/t03-nemotron-tools); `PROBE_ONLY=<prefix> PROBE_REPEAT=<n>` to repeat one experiment; results in gitignored `results/`).

| Experiment | What it checks |
|---|---|
| `single_tool_call` | "Weather in Paris in celsius" with `get_weather`; loop to an answer |
| `forced_tool_choice` | Unrelated prompt with `tool_choice` forcing `get_weather` |
| `structured_output_slice_plan` | `response_format: json_schema` + schema in the system prompt → Slice Plan |
| `long_loop_12_files` | `list_files` + `read_file` × 12 **independent** files, reply with the sum (13 calls) |
| `long_loop_parallel_hint` | As above, plus "issue independent calls in parallel" in the system prompt |
| `chained_loop_12_files` | 12 files where each names the next — **forces 12 sequential turns** for every model |
| `context_needle` | ~100k-token prompt of 3,000 near-identical records; return one record's code |
| `reasoning_off_single_tool_call` | As `single_tool_call` with `chat_template_kwargs: { enable_thinking: false }` |

## Results

| | Ultra | Super | Lightning | Nano |
|---|---|---|---|---|
| Single tool call | ✅ | ✅ | ✅ | ✅ |
| Forced `tool_choice` | ✅ | ✅ | ✅ | ✅ |
| JSON-schema Slice Plan (valid, 0 schema problems) | 4/4 | 4/4 | 4/4 | 4/4 |
| 12 independent files — correct | 6/6 | 6/6 (+3/3 hint) | 6/6 | **5/6** (+3/3 hint) |
| Parallel tool calls | **yes** (12 reads in 1 turn) | **never**, even with hint | **yes** | **never**, even with hint |
| Turns · avg wall time (independent) | 3 · 3.9 s | 14 · 17.1 s | 3 · 2.2 s | 14 · 23.8 s |
| Avg tokens in / out (independent) | 1,940 / 693 | 12,048 / 795 | 2,243 / 427 | 10,900 / 2,922 |
| Avg cost (independent) | $0.0040 | $0.0043 | $0.00024 | $0.0014 |
| **12 chained files (13 sequential turns) — correct** | 2/2 · 14.7 s · $0.012 | 2/2 · 14.0 s · $0.0038 | **0/3** — answers the last value (193) instead of the sum (1458) | 2/2 · 17.6 s · $0.0013 |
| **~100k-token needle (101k tokens in)** | ✗ (neighbouring record) · 4.7 s · $0.10 | ✗ ×3 (neighbouring record / empty) · 3.8–7.1 s | ✗ ×3 (neighbouring record) · 0.45–2.1 s | ✗ ×3 (neighbouring record) · 1.8–4.2 s |
| `enable_thinking: false` | accepted; 162 → 53 completion tokens, 2.4 → 1.5 s | accepted; 88 → 68 | accepted (no reasoning emitted for tools anyway) | accepted; 284 → 56, 1.8 → 0.8 s |

An earlier attempt at the needle test built a **~303k-token** prompt by mistake (synthetic codes tokenize at ~3 chars/token): Super and Nano rejected it (`400 maximum context length is 262144 tokens`), Ultra returned **empty content**, Lightning answered correctly.

## Findings

1. **Tool-call format is standard OpenAI.** `message.tool_calls[].function.arguments` is a JSON string; ids look like `chatcmpl-tool-…`; `finish_reason` is `tool_calls`. 0 malformed arguments and 0 calls to unknown tools in 521 calls.
2. **`tool_choice` forcing works** on all four, even with an unrelated prompt.
3. **JSON-schema output is reliable** (16/16 valid) when the schema is in both `response_format` and the prompt. We only tested "both" — the Token Factory docs recommend it; we did not test either alone. The shape was right but the *content* was not always what we mean: one Walking Skeleton included auth endpoints.
4. **Super and Nano never make parallel tool calls**, even when told to. Each call is a turn and each turn resends the whole conversation, so on independent reads Super used **6.2× Ultra's prompt tokens** and was **as expensive as Ultra and 4.4× slower**. When calls are genuinely sequential (chained), the models converge on turns and Super is **3× cheaper** than Ultra at similar speed.
5. **Lightning loses track over many sequential turns.** It followed all 12 links in the chain correctly but answered the last value instead of the sum, 3/3 times. It is excellent when it can parallelise, unreliable when it must accumulate state across turns — the normal shape of coding work.
6. **Long-context exact recall is unreliable on every model.** At ~100k tokens of near-identical records, all four consistently returned a neighbouring record's value (they locate the region, then misread the line). Super sometimes returns **empty content**; Ultra did too at ~300k. Latency stays low (Lightning's repeat of the same 100k prompt dropped from 2.1 s to 0.45 s, suggesting prefix caching).
7. **Reasoning** is returned in `message.reasoning_content` and is on by default. `chat_template_kwargs: { enable_thinking: false }` is accepted by all four and cuts completion tokens and latency (up to 5×). Lightning produced no reasoning for tool calls but ~5k characters of reasoning (≈ most of its 1,562 completion tokens) for the structured Slice Plan.
8. **Answers need checking in code.** Nano once read 11/12 files and answered confidently; Lightning confidently answered the wrong quantity; Super/Ultra sometimes return empty content.

## Rules for the agent loop (T08) and agents

1. Build on `TokenFactoryChatClient` / `ChatToolLoop`. **T08 must add** what the spike loop does not: store `reasoning_content` in the Transcript (the spike only counts characters), Working Memory, Token Budget.
2. **Offer batch tools** — e.g. `read_files(paths[])`, `write_files(files[])` — alongside single-item tools. Super and Nano will not parallelise on their own; batch tools remove most of their turn/token penalty.
3. **Count turns and tokens per Step** against the Token Budget and keep contexts short; prompt cost grows with every turn.
4. **Never rely on long-context recall for exact facts.** Give agents search/read tools (grep, read a range, read a file) instead of pasting whole codebases or long documents; keep a prompt well under ~100k tokens of dense data.
5. **Validate every structured response in code** (JSON Schema + domain checks such as "Slice 1 is a real Walking Skeleton"); on failure, retry once with the validation errors. Send the schema in both `response_format` and the prompt.
6. **Verify outcomes in code, not from the model's final message** — e.g. every planned file written, tests actually executed and passed. Treat **empty content** as a failed Step and retry.
7. **Thinking on for judgement, off for mechanics:** reasoning on for System Design, Orchestrator decisions and Code Review; `enable_thinking: false` is available per call for mechanical loops. Make it a per-role config flag.
8. **Handle 429** using `Retry-After` (`ChatApiError.retryAfterSeconds`). Our parallelism (2 Coding Agents at once) is far below the per-model limits on paper, but this was not load-tested.
9. Use exact model ids from `/v1/models`.

## Model defaults per role

The agreed defaults (grilling Q5): **Ultra** for Orchestrator / System Design / Code Review, **Super** for Coding / Testing / UI Design.

The data **supports keeping them**:

- Super is correct on both independent and sequential loops, and cheapest-but-reliable for sequential work (the common case in coding). Its weakness — no parallel calls — is addressed by rule 2 (batch tools).
- Lightning is attractive on price and speed but failed every sequential-accumulation run, so it is **not** a safe default for Coding/Testing. It could suit narrow, parallel, single-shot jobs later.
- Nano skipped a file once and is the slowest; not recommended for agents.
- Ultra is the most robust for reasoning roles; watch its cost on long sequential loops (3× Super).

T15 should still compare Super vs Ultra on a real coding Slice before the demo; switching is a config change.

## Appendix: what the real API returned

Super, first turn of `single_tool_call` (assistant message as appended to the conversation):

```json
{"role":"assistant","content":null,"tool_calls":[{"id":"chatcmpl-tool-b3e3754138a63e9f","type":"function","function":{"name":"get_weather","arguments":"{\"city\": \"Paris\", \"unit\": \"celsius\"}"}}]}
```

Ultra, `forced_tool_choice` ("Tell me a joke." with `get_weather` forced):

```json
[{"id":"chatcmpl-tool-a66e97bfe624ec68","name":"get_weather","arguments":"{\"city\": \"Paris\", \"unit\": \"celsius\"}"}]
```

Super, `structured_output_slice_plan` content (schema-valid, but Slice 1 is not a real Walking Skeleton):

```json
{"slices": [{"order": 1, "name": "Walking skeleton", "endpoints": ["GET /health", "POST /register", "POST /login", "GET /lists", "POST /lists"]}, {"order": 2, "name": "Auth & Todo core", "endpoints": ["POST /register (real)", "POST /login (JWT)", "GET /me", "GET /lists", "POST /lists", "GET /lists/:id", "PUT /lists/:id", "DELETE /lists/:id", "GET /lists/:id/todos", "POST /lists/:id/todos", "PUT /lists/:id/todos/:todoId", "DELETE /lists/:id/todos/:todoId"]}, {"order": 3, "name": "Shared lists & invites", "endpoints": ["POST /lists/:id/invite", "GET /invites/:token", "POST /invites/:token/accept", "GET /users/:userId/lists"]}]}
```

Lightning, `chained_loop_12_files` final content after 12 correct reads (expected `1458`, the sum; `193` is the last file's value):

```text
193
```

`context_needle` answers for `record-01860` (expected `QX7-PELICAN-4418`); each is the code of a nearby record:

| Model | Answer | Belongs to |
|---|---|---|
| Ultra | `C63288-3V-4` | record-01902 |
| Super | `C97888-35-6` (×2), empty (×1) | nearby record / — |
| Lightning | `The code is C38582-NY-2.` (×3) | record-01861 |
| Nano | `C13876-GC-0` (×3) | record-01820 |

Super and Nano on the ~303k-token prompt:

```text
Token Factory 400: This model's maximum context length is 262144 tokens. However, you requested 2000 output tokens and your prompt contains at least 260145 input tokens, for a total of at least 262145 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=260145)
```

Nano, the one wrong independent-files run: 12 tool calls, 11 distinct files read, final content `"\n2552"` (expected 3018).
