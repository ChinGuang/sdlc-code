/**
 * Parses Mermaid in Node. Mermaid's sanitiser (DOMPurify) wants a DOM when it
 * loads, so a tiny linkedom DOM is lent to it for the import only and removed
 * afterwards: nothing else in the process ever sees a global `window`.
 */
type Mermaid = { parse: (text: string) => Promise<unknown> };

let loading: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  loading ??= (async () => {
    const lendDom = !("window" in globalThis);
    if (lendDom) {
      const { parseHTML } = await import("linkedom");
      const { window } = parseHTML("<html><body></body></html>");
      Object.assign(globalThis, { window, document: window.document });
    }
    try {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({ startOnLoad: false });
      return mermaid;
    } finally {
      if (lendDom) {
        const global = globalThis as { window?: unknown; document?: unknown };
        delete global.window;
        delete global.document;
      }
    }
  })();
  return loading;
}

/** Null when `source` is valid Mermaid; otherwise the parser's first error line. */
export async function mermaidProblem(source: string): Promise<string | null> {
  const mermaid = await loadMermaid();
  try {
    await mermaid.parse(source);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.split("\n").slice(0, 3).join(" ").slice(0, 300);
  }
}
