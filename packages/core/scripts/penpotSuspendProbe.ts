/**
 * Measures what the spike deferred to T10: how the Penpot MCP behaves while the
 * plugin tab is backgrounded, and how quickly it recovers when refocused.
 *
 * Calls execute_code every 3s for 3 minutes, logging outcome and duration, then
 * prints a summary. Run it, background the Penpot tab, wait ~60s, refocus.
 */
import { connectPenpotMcp } from "@sdlc-code/clients";

const url = process.env.PENPOT_MCP_URL;
if (!url) {
  console.error("Set PENPOT_MCP_URL in sdlc-code/.env");
  process.exit(1);
}

const connection = await connectPenpotMcp({ url });
const started = Date.now();
const events: Array<{ at: number; ms: number; outcome: string }> = [];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

console.log(
  "Probing for 3 minutes. Background the Penpot tab now; refocus after ~60s.",
);
try {
  while (Date.now() - started < 180_000) {
    const at = Math.round((Date.now() - started) / 1000);
    const callStarted = Date.now();
    let outcome: string;
    try {
      // A cheap read, and a counter so a partly executed call would show up.
      const value = await connection.penpot.executeCode<number>(
        "storage.probe = (storage.probe ?? 0) + 1; return storage.probe;",
      );
      outcome = `ok (counter ${value})`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = message.slice(0, 120).replaceAll("\n", " ");
    }
    const ms = Date.now() - callStarted;
    events.push({ at, ms, outcome });
    console.log(
      `${String(at).padStart(3)}s  ${String(ms).padStart(6)}ms  ${outcome}`,
    );
    await sleep(3000);
  }
} finally {
  await connection.close();
}

const failures = events.filter((event) => !event.outcome.startsWith("ok"));
console.log("\nSummary");
console.log(`  calls: ${events.length}, failures: ${failures.length}`);
if (failures.length > 0) {
  console.log(
    `  first failure at ${failures[0]!.at}s after ${failures[0]!.ms}ms`,
  );
  console.log(`  last failure at ${failures.at(-1)!.at}s`);
  const slowest = Math.max(...failures.map((event) => event.ms));
  const fastest = Math.min(...failures.map((event) => event.ms));
  console.log(`  failing call duration: ${fastest}ms - ${slowest}ms`);
  const recovered = events.find(
    (event) => event.at > failures.at(-1)!.at && event.outcome.startsWith("ok"),
  );
  if (recovered)
    console.log(`  recovered at ${recovered.at}s in ${recovered.ms}ms`);
}
const counters = events
  .map((event) => /counter (\d+)/.exec(event.outcome)?.[1])
  .filter(Boolean);
console.log(
  `  counter went ${counters[0]} → ${counters.at(-1)} over ${counters.length} successful calls`,
);
