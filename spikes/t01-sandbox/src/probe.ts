/**
 * T01 live probe: answers the spike questions against the real Sandboxes API.
 * Run: pnpm probe   (reads NEBIUS_API_KEY and NEBIUS_AI_PROJECT from ../../.env)
 * Writes a secret-free summary to results/probe-<timestamp>.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createSandboxClient, type RunResult, type SandboxClient } from "./sandboxClient.js";

const token = process.env.NEBIUS_API_KEY;
const project = process.env.NEBIUS_AI_PROJECT;
if (!token || !project) {
  console.error("Set NEBIUS_API_KEY and NEBIUS_AI_PROJECT in sdlc-code/.env");
  process.exit(1);
}

const client = createSandboxClient({ token, project, baseUrl: process.env.NEBIUS_SANDBOX_URL });
const NODE_IMAGE_TAG = process.env.PROBE_NODE_TAG ?? "sdlc-code/node:22-slim";
const findings: Record<string, unknown> = { startedAt: new Date().toISOString() };

function summary(result: RunResult) {
  return {
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

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const started = Date.now();
  process.stdout.write(`▶ ${name} … `);
  try {
    const value = await fn();
    findings[name] = { ok: true, wallMs: Date.now() - started, value };
    console.log(`ok (${Date.now() - started} ms)`);
    return value;
  } catch (error) {
    findings[name] = { ok: false, wallMs: Date.now() - started, error: String(error) };
    console.log(`FAILED: ${String(error)}`);
    return undefined;
  }
}

async function nodeImage(sdk: SandboxClient): Promise<string> {
  const existing = await sdk.listImages(NODE_IMAGE_TAG);
  const match = existing.images.find((image) => image.tag === NODE_IMAGE_TAG);
  if (match) return match.uuid;
  const operationId = await sdk.importImage("docker://docker.io/library/node:22-slim", NODE_IMAGE_TAG);
  const done = await sdk.waitForOperation(operationId, { pollMs: 3000, timeoutMs: 20 * 60_000 });
  if (done.status !== "SUCCESS") throw new Error(`import ${done.status}: ${done.error}`);
  const image = done.result?.image;
  if (!image) throw new Error("import succeeded without image uuid");
  return image;
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

async function main() {
  await step("auth_listImages", async () => (await client.listImages()).images.slice(0, 20));

  const base = await step("node_image", () => nodeImage(client));
  if (!base) return;

  await step("hello_run", async () => summary(await client.run({ image: base, command: "node -v && uname -a && nproc && free -m", shell: true, disposable: true, timeout: 60 })));

  await step("network_npm_view", async () =>
    summary(await client.run({ image: base, command: "npm view express version", shell: true, disposable: true, timeout: 120 })),
  );

  const server = await step("upload_file", () => client.uploadFile(SERVER));
  if (server) {
    await step("port_binding_smoke_test", async () =>
      summary(
        await client.run({
          image: base,
          command: SMOKE,
          shell: true,
          disposable: true,
          timeout: 60,
          files: { "/app/server.cjs": { uuid: server.uuid, mode: "0644" } },
        }),
      ),
    );
  }

  const installed = await step("base_snapshot_npm_install", async () =>
    summary(
      await client.run({ image: base, command: "mkdir -p /app && cd /app && npm init -y >/dev/null && npm i express@4 --silent && ls node_modules | wc -l", shell: true, timeout: 600 }),
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
  }

  await step("timeout_enforced", async () =>
    summary(await client.run({ image: base, command: "sleep 30", shell: true, disposable: true, timeout: 5 }, { timeoutMs: 120_000 })),
  );
}

await main().finally(() => {
  findings.finishedAt = new Date().toISOString();
  mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
  const file = new URL(`../results/probe-${Date.now()}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(findings, null, 2));
  console.log(`\nwrote ${file.pathname}`);
});
