/**
 * T01 live probe: answers the spike questions against the real Sandboxes API.
 * Run: pnpm probe   (reads NEBIUS_API_KEY and NEBIUS_AI_PROJECT from ../../.env)
 * Writes a secret-free summary to results/probe-<timestamp>.json (gitignored).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  commandSucceeded,
  NebiusSandboxClient,
  type RunResult,
  type SandboxClient,
} from "./sandboxClient.js";

const envToken = process.env.NEBIUS_API_KEY;
const envProject = process.env.NEBIUS_AI_PROJECT;
if (!envToken || !envProject) {
  console.error("Set NEBIUS_API_KEY and NEBIUS_AI_PROJECT in sdlc-code/.env");
  process.exit(1);
}
const token: string = envToken;
const project: string = envProject;
const baseUrl = process.env.NEBIUS_SANDBOX_URL ?? "https://api.tokenfactory.nebius.com/sandboxes/v1";
const client: SandboxClient = new NebiusSandboxClient({ token, project, baseUrl });
const NODE_IMAGE_TAG = process.env.PROBE_NODE_TAG ?? "sdlc-code/node:22-slim";
const findings: Record<string, unknown> = { startedAt: new Date().toISOString() };

/** Removes the key and project id from anything we store or print. */
const redact = (text: string) => text.split(token).join("<key>").split(project).join("<project>");

function summary(result: RunResult) {
  return {
    commandSucceeded: commandSucceeded(result),
    status: result.status,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationSeconds: result.durationSeconds,
    cost: result.cost,
    stdout: result.stdout.slice(0, 2000),
    stderr: result.stderr.slice(0, 2000),
    resultImage: result.resultImage,
    error: result.error,
  };
}

/** PROBE_ONLY=step1,step2 runs only those steps (plus node_image, which others need). */
const only = process.env.PROBE_ONLY?.split(",");

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (only && name !== "node_image" && !only.includes(name)) return undefined;
  const started = Date.now();
  process.stdout.write(`▶ ${name} … `);
  try {
    const value = await fn();
    findings[name] = { ok: true, wallMs: Date.now() - started, value };
    console.log(`ok (${Date.now() - started} ms)`);
    return value;
  } catch (error) {
    findings[name] = { ok: false, wallMs: Date.now() - started, error: redact(String(error)) };
    console.log(`FAILED: ${redact(String(error))}`);
    return undefined;
  }
}

async function rawGet(path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Project: project },
  });
  return JSON.parse(redact(await response.text()));
}

async function allImageTags(): Promise<string[]> {
  const tags: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await rawGet(`/images?limit=100&offset=${offset}`)) as { images?: Array<{ tag?: string }> };
    const images = page.images ?? [];
    tags.push(...images.map((i) => i.tag ?? "(untagged)"));
    if (images.length < 100) return tags;
  }
}

async function nodeImage(sandbox: SandboxClient): Promise<{ uuid: string; imported: boolean }> {
  const existing = await sandbox.listImages(NODE_IMAGE_TAG);
  const match = existing.images.find((image) => image.tag === NODE_IMAGE_TAG);
  if (match) return { uuid: match.uuid, imported: false };
  const operationId = await sandbox.importImage("docker://docker.io/library/node:22-slim", NODE_IMAGE_TAG);
  const done = await sandbox.waitForOperation(operationId, { pollMs: 3000, timeoutMs: 20 * 60_000 });
  if (done.status !== "SUCCESS") throw new Error(`import ${done.status}: ${done.error}`);
  const image = done.result?.image;
  if (!image) throw new Error("import succeeded without image uuid");
  return { uuid: image, imported: true };
}

const SERVER = `
const http = require("node:http");
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, path: req.url }));
}).listen(3000, () => console.log("listening"));
`;

const SMOKE = `
node /app/server.cjs & SERVER_PID=$!
for i in $(seq 1 50); do node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(j=>{console.log('smoke', JSON.stringify(j));process.exit(0)}).catch(()=>process.exit(1))" && break; sleep 0.2; done
STATUS=$?
kill $SERVER_PID
exit $STATUS
`;

// A minimal "Slice" for the end-to-end Test Run: code + a unit test, run with node:test.
const SUM_MODULE = "exports.sum = (a, b) => a + b;\n";
const SUM_TEST = `
const test = require("node:test");
const assert = require("node:assert");
const { sum } = require("./sum.cjs");
test("sum adds", () => assert.strictEqual(sum(2, 3), 5));
test("sum with zero", () => assert.strictEqual(sum(0, 7), 7));
`;
const TEST_RUN_SCRIPT = `
set -e
cd /app
node -e "require('express'); console.log('deps from Base Snapshot ok')"
node --test --test-reporter=tap sum.test.cjs
set +e
${SMOKE}
`;

async function main() {
  await step("whoami", async () => {
    const who = (await rawGet("/whoami")) as Record<string, unknown>;
    return { permissions: who.permissions, limits: who.limits };
  });

  await step("images_catalog", async () => {
    const tags = await allImageTags();
    return { total: tags.length, node: tags.filter((t) => /(^|\/)node:/.test(t)).sort() };
  });

  const base = await step("node_image", () => nodeImage(client));
  if (!base) return;
  const image = base.uuid;

  await step("hello_run", async () =>
    summary(await client.run({ image, command: "node -v && uname -a && nproc && free -m", shell: true, disposable: true, timeout: 60 })),
  );

  await step("raw_exit_code_example", async () => {
    const operationId = await client.spawn({ image, command: "echo hello; exit 3", shell: true, disposable: true, timeout: 30 });
    await client.waitForOperation(operationId, { pollMs: 250 });
    return rawGet(`/operations/${operationId}`);
  });

  await step("network_npm_view", async () =>
    summary(await client.run({ image, command: "npm view express version", shell: true, disposable: true, timeout: 120 })),
  );

  const server = await step("upload_file", () => client.uploadFile(SERVER));
  if (server) {
    await step("port_binding_smoke_test", async () =>
      summary(
        await client.run({
          image,
          command: SMOKE,
          shell: true,
          disposable: true,
          timeout: 60,
          files: { "/app/server.cjs": { uuid: server.uuid, mode: "0644" } },
        }),
      ),
    );

    await step("processes_not_kept_between_runs", async () => {
      const first = await client.run({
        image,
        command: "nohup node /app/server.cjs >/tmp/server.log 2>&1 & sleep 1; cat /tmp/server.log",
        shell: true,
        timeout: 60,
        files: { "/app/server.cjs": { uuid: server.uuid, mode: "0644" } },
      });
      if (!first.resultImage) throw new Error("first run produced no image");
      const second = await client.run({
        image: first.resultImage,
        command:
          "node -e \"fetch('http://127.0.0.1:3000/health').then(()=>{console.log('still running');process.exit(0)}).catch(()=>{console.log('not running');process.exit(1)})\"; echo files: $(ls /app) $(ls /tmp)",
        shell: true,
        disposable: true,
        timeout: 60,
      });
      return { first: summary(first), second: summary(second) };
    });
  }

  const installed = await step("base_snapshot_npm_install", async () =>
    summary(
      await client.run({
        image,
        command: "mkdir -p /app && cd /app && npm init -y >/dev/null && npm i express@4 --silent && ls node_modules | wc -l",
        shell: true,
        timeout: 600,
      }),
    ),
  );
  const snapshot = installed?.resultImage;

  if (snapshot) {
    const branchA = await step("branch_a_write", async () =>
      summary(await client.run({ image: snapshot, command: "echo A > /app/branch.txt && cat /app/branch.txt", shell: true, timeout: 60 })),
    );
    await step("branch_b_isolated_from_a", async () =>
      summary(await client.run({ image: snapshot, command: "test ! -f /app/branch.txt && echo isolated && ls /app/node_modules | wc -l", shell: true, timeout: 60 })),
    );
    if (branchA?.resultImage) {
      await step("branch_a_state_persisted", async () =>
        summary(await client.run({ image: branchA.resultImage!, command: "cat /app/branch.txt", shell: true, disposable: true, timeout: 60 })),
      );
    }

    await step("test_run_end_to_end", async () => {
      // ADR 0001 Test Run: branch the Base Snapshot, upload only changed files, one disposable run.
      const [sum, sumTest, serverFile] = await Promise.all([
        client.uploadFile(SUM_MODULE),
        client.uploadFile(SUM_TEST),
        client.uploadFile(SERVER),
      ]);
      const started = Date.now();
      const result = await client.run(
        {
          image: snapshot,
          command: TEST_RUN_SCRIPT,
          shell: true,
          disposable: true,
          timeout: 300,
          files: {
            "/app/sum.cjs": { uuid: sum.uuid, mode: "0644" },
            "/app/sum.test.cjs": { uuid: sumTest.uuid, mode: "0644" },
            "/app/server.cjs": { uuid: serverFile.uuid, mode: "0644" },
          },
        },
        { pollMs: 250 },
      );
      return { runWallMs: Date.now() - started, ...summary(result) };
    });
  }

  await step("timeout_enforced", async () =>
    summary(await client.run({ image, command: "sleep 30", shell: true, disposable: true, timeout: 5 }, { timeoutMs: 120_000 })),
  );

  await step("long_run_120s", async () =>
    summary(
      await client.run(
        { image, command: "for i in $(seq 1 12); do sleep 10; echo tick $i; done", shell: true, disposable: true, timeout: 300 },
        { pollMs: 2000, timeoutMs: 400_000 },
      ),
    ),
  );

  await step("polling_overhead", async () => {
    const rows: Array<{ pollMs: number; wallMs: number[]; serverMs: number[] }> = [];
    for (const pollMs of [1000, 250, 100]) {
      const row = { pollMs, wallMs: [] as number[], serverMs: [] as number[] };
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        const result = await client.run({ image, command: "node -e 'console.log(1)'", shell: true, disposable: true, timeout: 30 }, { pollMs });
        row.wallMs.push(Date.now() - started);
        row.serverMs.push(Math.round((result.durationSeconds ?? 0) * 1000));
      }
      rows.push(row);
    }
    return rows;
  });
}

await main().finally(() => {
  findings.finishedAt = new Date().toISOString();
  mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
  const file = new URL(`../results/probe-${Date.now()}.json`, import.meta.url);
  writeFileSync(file, redact(JSON.stringify(findings, null, 2)));
  console.log(`\nwrote ${file.pathname}`);
});
