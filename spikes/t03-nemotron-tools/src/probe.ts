/**
 * T03 live probe: tool calling, structured output and long tool loops on Nemotron models.
 * Run: pnpm probe [model-substring ...]   (reads NEBIUS_API_KEY from ../../.env; never logged)
 * Writes results/probe-<ts>.json (gitignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  costUsd,
  parseToolArguments,
  TokenFactoryChatClient,
  type ChatClient,
  type Pricing,
  type Usage,
} from "./chatClient.js";
import { ChatToolLoop, type LoopTools } from "./toolLoop.js";

const apiKey = process.env.NEBIUS_API_KEY;
if (!apiKey) {
  console.error("Set NEBIUS_API_KEY in sdlc-code/.env");
  process.exit(1);
}
const baseUrl = process.env.NEBIUS_BASE_URL;
const client: ChatClient = new TokenFactoryChatClient({ apiKey, baseUrl });

const MODELS: Record<string, Pricing> = {
  "nvidia/Nemotron-3-Ultra-550b-a55b": { promptPerMillion: 1, completionPerMillion: 3 },
  "nvidia/nemotron-3-super-120b-a12b": { promptPerMillion: 0.3, completionPerMillion: 0.9 },
  "nvidia/Nemotron-3_5-Lightning": { promptPerMillion: 0.06, completionPerMillion: 0.24 },
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": { promptPerMillion: 0.06, completionPerMillion: 0.24 },
};
const filters = process.argv.slice(2).map((f) => f.toLowerCase());
const models = Object.keys(MODELS).filter(
  (m) => filters.length === 0 || filters.some((f) => m.toLowerCase().includes(f)),
);

const EXPERIMENT_TIMEOUT_MS = 240_000;
/** PROBE_ONLY=long_loop PROBE_REPEAT=5 pnpm probe … repeats only the long loop. */
const only = process.env.PROBE_ONLY;
const repeat = Math.max(1, Number(process.env.PROBE_REPEAT ?? 1));
const enabled = (name: string) => !only || name.startsWith(only);
const findings: Record<string, Record<string, unknown>> = {};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}

async function experiment(model: string, name: string, fn: () => Promise<Record<string, unknown>>) {
  if (!enabled(name)) return;
  for (let i = 1; i <= repeat; i++) await experimentOnce(model, repeat > 1 ? `${name}#${i}` : name, fn);
}

async function experimentOnce(model: string, name: string, fn: () => Promise<Record<string, unknown>>) {
  process.stdout.write(`▶ ${model.split("/")[1]} · ${name} … `);
  const started = Date.now();
  try {
    const value = await withTimeout(fn(), EXPERIMENT_TIMEOUT_MS);
    (findings[model] ??= {})[name] = { ok: true, wallMs: Date.now() - started, ...value };
    console.log(`ok (${Date.now() - started} ms) ${JSON.stringify(value.summary ?? "")}`);
  } catch (error) {
    (findings[model] ??= {})[name] = { ok: false, wallMs: Date.now() - started, error: String(error).slice(0, 600) };
    console.log(`FAILED: ${String(error).slice(0, 300)}`);
  }
}

const cost = (model: string, usage: Usage) => Number(costUsd(usage, MODELS[model]!).toFixed(6));

// --- tools -------------------------------------------------------------------

const weatherTools: LoopTools = {
  get_weather: {
    definition: {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name, e.g. Paris" },
          unit: { type: "string", enum: ["celsius", "fahrenheit"] },
        },
        required: ["city", "unit"],
      },
    },
    handler: (args) => JSON.stringify({ city: args.city, unit: args.unit, temperature: 18, condition: "sunny" }),
  },
};

const FILES: Record<string, number> = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [`data/part-${String(i + 1).padStart(2, "0")}.txt`, (i + 1) * 37 + (i % 3) * 11]),
);
const EXPECTED_SUM = Object.values(FILES).reduce((a, b) => a + b, 0);

const fileTools = (reads: string[]): LoopTools => ({
  list_files: {
    definition: {
      name: "list_files",
      description: "List all file paths in the workspace.",
      parameters: { type: "object", properties: {} },
    },
    handler: () => JSON.stringify(Object.keys(FILES)),
  },
  read_file: {
    definition: {
      name: "read_file",
      description: "Read ONE file and return its content. Call once per file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Exact path from list_files" } },
        required: ["path"],
      },
    },
    handler: (args) => {
      const path = String(args.path);
      reads.push(path);
      if (!(path in FILES)) throw new Error(`no such file: ${path}`);
      return `value=${FILES[path]}`;
    },
  },
});

const CHAIN: Array<{ path: string; value: number }> = Array.from({ length: 12 }, (_, i) => ({
  path: i === 0 ? "chain/start.txt" : `chain/node-${String((i * 7) % 12).padStart(2, "0")}-${i}.txt`,
  value: 50 + i * 13,
}));
const CHAIN_SUM = CHAIN.reduce((a, c) => a + c.value, 0);

const chainTools = (reads: string[]): LoopTools => ({
  read_file: {
    definition: {
      name: "read_file",
      description: "Read ONE file and return its content.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    handler: (args) => {
      const path = String(args.path);
      reads.push(path);
      const index = CHAIN.findIndex((c) => c.path === path);
      if (index < 0) throw new Error(`no such file: ${path}`);
      const next = CHAIN[index + 1];
      return `value=${CHAIN[index]!.value}; next=${next ? next.path : "END"}`;
    },
  },
});

// Haystack of synthetic records with one needle (~33 tokens per line; 3000 lines ≈ 100k tokens).
const HAYSTACK_LINES = Number(process.env.HAYSTACK_LINES ?? 3000);
const NEEDLE_ID = `record-${String(Math.floor(HAYSTACK_LINES * 0.62)).padStart(5, "0")}`;
const NEEDLE_CODE = "QX7-PELICAN-4418";
const HAYSTACK = Array.from({ length: HAYSTACK_LINES }, (_, i) => {
  const id = `record-${String(i).padStart(5, "0")}`;
  const code = id === NEEDLE_ID ? NEEDLE_CODE : `C${(i * 7919) % 99991}-${((i * 31) % 997).toString(36).toUpperCase()}-${i % 13}`;
  return `${id}: owner=user${i % 251} region=eu-${i % 7} code=${code} status=${i % 3 === 0 ? "active" : "archived"}`;
}).join("\n");

const SLICE_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["slices"],
  properties: {
    slices: {
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["order", "name", "endpoints"],
        properties: {
          order: { type: "integer" },
          name: { type: "string" },
          endpoints: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function checkSlicePlan(value: unknown): string[] {
  const problems: string[] = [];
  const slices = (value as { slices?: unknown })?.slices;
  if (!Array.isArray(slices) || slices.length < 2) return ["slices missing or < 2"];
  slices.forEach((s, i) => {
    const slice = s as Record<string, unknown>;
    if (typeof slice.order !== "number") problems.push(`slice ${i}: order not a number`);
    if (typeof slice.name !== "string") problems.push(`slice ${i}: name not a string`);
    if (!Array.isArray(slice.endpoints)) problems.push(`slice ${i}: endpoints not an array`);
    const extra = Object.keys(slice).filter((k) => !["order", "name", "endpoints"].includes(k));
    if (extra.length) problems.push(`slice ${i}: extra keys ${extra.join(",")}`);
  });
  return problems;
}

// --- experiments ---------------------------------------------------------------

for (const model of models) {
  await experiment(model, "single_tool_call", async () => {
    const loop = new ChatToolLoop({ client, model, tools: weatherTools, maxIterations: 4, temperature: 0 });
    const r = await loop.run({
      system: "You are a helpful assistant. Use tools when they help.",
      user: "What's the weather in Paris right now, in celsius?",
    });
    const firstCall = r.messages.find((m) => m.role === "assistant");
    return {
      summary: { calls: r.toolCallCount, stop: r.stopReason, mentions18: /18/.test(r.finalContent ?? "") },
      toolCallCount: r.toolCallCount,
      iterations: r.iterations,
      malformedArguments: r.malformedArguments,
      firstAssistantMessage: firstCall,
      finalContent: r.finalContent?.slice(0, 400),
      reasoningChars: r.reasoningChars,
      usage: r.usage,
      costUsd: cost(model, r.usage),
      latencyMs: r.latencyMs,
    };
  });

  await experiment(model, "forced_tool_choice", async () => {
    const response = await client.complete({
      model,
      temperature: 0,
      messages: [{ role: "user", content: "Tell me a joke." }],
      tools: [weatherTools.get_weather!.definition],
      toolChoice: { name: "get_weather" },
    });
    const call = response.toolCalls[0];
    return {
      summary: { forcedCall: call?.name ?? null, argsValid: call ? parseToolArguments(call.arguments).ok : false },
      toolCalls: response.toolCalls,
      finishReason: response.finishReason,
      latencyMs: response.latencyMs,
      usage: response.usage,
    };
  });

  await experiment(model, "structured_output_slice_plan", async () => {
    const response = await client.complete({
      model,
      temperature: 0,
      jsonSchema: { name: "slice_plan", schema: SLICE_PLAN_SCHEMA },
      messages: [
        {
          role: "system",
          content: `Return ONLY JSON matching this JSON Schema, no prose:\n${JSON.stringify(SLICE_PLAN_SCHEMA)}`,
        },
        {
          role: "user",
          content: "Slice plan for a todo app with email/password auth and shared lists. Slice 1 must be a walking skeleton.",
        },
      ],
    });
    const raw = response.content ?? "";
    let parsed: unknown;
    let parseError: string | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      parseError = String(error);
    }
    const problems = parseError ? [parseError] : checkSlicePlan(parsed);
    return {
      summary: { validJson: !parseError, schemaProblems: problems.length },
      problems,
      rawContent: raw.slice(0, 1500),
      reasoningChars: response.reasoning?.length ?? 0,
      finishReason: response.finishReason,
      latencyMs: response.latencyMs,
      usage: response.usage,
      costUsd: cost(model, response.usage),
    };
  });

  await experiment(model, "long_loop_12_files", async () => {
    const reads: string[] = [];
    const loop = new ChatToolLoop({ client, model, tools: fileTools(reads), maxIterations: 30, temperature: 0 });
    const r = await loop.run({
      system: "You are a careful agent. Use the tools; never guess file contents.",
      user: "List the files, read EVERY file with read_file (one path per call), add up all the values, and reply with only the final sum as a number.",
    });
    const answer = Number((r.finalContent ?? "").replace(/[^0-9.-]/g, " ").trim().split(/\s+/).pop());
    const distinctReads = new Set(reads.filter((p) => p in FILES)).size;
    return {
      summary: { correct: answer === EXPECTED_SUM, calls: r.toolCallCount, parallelTurns: r.parallelTurns, iterations: r.iterations },
      expected: EXPECTED_SUM,
      answer,
      stopReason: r.stopReason,
      toolCallCount: r.toolCallCount,
      distinctFilesRead: distinctReads,
      badPaths: reads.filter((p) => !(p in FILES)),
      parallelTurns: r.parallelTurns,
      iterations: r.iterations,
      malformedArguments: r.malformedArguments,
      unknownTools: r.unknownTools,
      reasoningChars: r.reasoningChars,
      usage: r.usage,
      costUsd: cost(model, r.usage),
      latencyMs: r.latencyMs,
      avgLatencyPerTurnMs: Math.round(r.latencyMs / Math.max(1, r.iterations)),
      finalContent: r.finalContent?.slice(0, 300),
    };
  });

  await experiment(model, "long_loop_parallel_hint", async () => {
    const reads: string[] = [];
    const loop = new ChatToolLoop({ client, model, tools: fileTools(reads), maxIterations: 30, temperature: 0 });
    const r = await loop.run({
      system:
        "You are a careful agent. Use the tools; never guess file contents. When several tool calls do not depend on each other, issue them together in a single turn (parallel tool calls).",
      user: "List the files, read EVERY file with read_file (one path per call), add up all the values, and reply with only the final sum as a number.",
    });
    const answer = Number((r.finalContent ?? "").replace(/[^0-9.-]/g, " ").trim().split(/\s+/).pop());
    return {
      summary: { correct: answer === EXPECTED_SUM, calls: r.toolCallCount, parallelTurns: r.parallelTurns, iterations: r.iterations },
      answer,
      toolCallCount: r.toolCallCount,
      parallelTurns: r.parallelTurns,
      iterations: r.iterations,
      usage: r.usage,
      costUsd: cost(model, r.usage),
      latencyMs: r.latencyMs,
    };
  });

  await experiment(model, "chained_loop_12_files", async () => {
    // Each file names the next one, so reads cannot be parallelised: 12+ sequential turns.
    const reads: string[] = [];
    const loop = new ChatToolLoop({ client, model, tools: chainTools(reads), maxIterations: 30, temperature: 0 });
    const r = await loop.run({
      system: "You are a careful agent. Use the tools; never guess file contents.",
      user: "Start by reading chain/start.txt. Each file has a value and names the next file. Follow the chain to the end, add up all the values, and reply with only the final sum as a number.",
    });
    const answer = Number((r.finalContent ?? "").replace(/[^0-9.-]/g, " ").trim().split(/\s+/).pop());
    return {
      summary: { correct: answer === CHAIN_SUM, calls: r.toolCallCount, iterations: r.iterations },
      expected: CHAIN_SUM,
      answer,
      stopReason: r.stopReason,
      toolCallCount: r.toolCallCount,
      iterations: r.iterations,
      malformedArguments: r.malformedArguments,
      usage: r.usage,
      costUsd: cost(model, r.usage),
      latencyMs: r.latencyMs,
      avgLatencyPerTurnMs: Math.round(r.latencyMs / Math.max(1, r.iterations)),
      finalContent: r.finalContent?.slice(0, 600),
    };
  });

  await experiment(model, "context_needle", async () => {
    const response = await client.complete({
      model,
      temperature: 0,
      maxTokens: 2000,
      messages: [
        { role: "system", content: "Answer using only the provided records. Reply with only the code." },
        { role: "user", content: `${HAYSTACK}

What is the code of ${NEEDLE_ID}?` },
      ],
    });
    return {
      summary: { correct: (response.content ?? "").includes(NEEDLE_CODE), promptTokens: response.usage.promptTokens, latencyMs: response.latencyMs },
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      latencyMs: response.latencyMs,
      answer: response.content?.slice(0, 200),
      costUsd: cost(model, response.usage),
    };
  });

  await experiment(model, "reasoning_off_single_tool_call", async () => {
    const loop = new ChatToolLoop({
      client,
      model,
      tools: weatherTools,
      maxIterations: 4,
      temperature: 0,
      extra: { chat_template_kwargs: { enable_thinking: false } },
    });
    const r = await loop.run({
      system: "You are a helpful assistant. Use tools when they help.",
      user: "What's the weather in Paris right now, in celsius?",
    });
    return {
      summary: { calls: r.toolCallCount, reasoningChars: r.reasoningChars },
      toolCallCount: r.toolCallCount,
      reasoningChars: r.reasoningChars,
      usage: r.usage,
      latencyMs: r.latencyMs,
      costUsd: cost(model, r.usage),
    };
  });
}

mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const file = new URL(`../results/probe-${Date.now()}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), expectedSum: EXPECTED_SUM, findings }, null, 2));
console.log(`\nwrote ${file.pathname}`);
