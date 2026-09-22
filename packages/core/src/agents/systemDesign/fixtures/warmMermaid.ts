import { mermaidProblem } from "../mermaid.js";

/**
 * Loads Mermaid once, in a `beforeAll`, so its cold import is not charged to
 * whichever test happens to parse first. The load is inherently slow: ~1.5s
 * alone, and over 30s when every Vitest project imports its dependencies at
 * once, hence the generous hook timeout. Tests keep the default timeout.
 */
export const MERMAID_LOAD_TIMEOUT = 120_000;

export async function warmMermaid(): Promise<void> {
  await mermaidProblem("flowchart TD\n  A --> B");
}
