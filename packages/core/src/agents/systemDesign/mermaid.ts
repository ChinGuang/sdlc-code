/**
 * Parses Mermaid in Node. Mermaid's sanitiser (DOMPurify) wants a DOM when it
 * loads, so a tiny linkedom DOM is lent to it while the module loads (once per
 * process, ~1.5s) and removed afterwards. Code running during that load could
 * see the global `window`; parsing afterwards needs none.
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
    } catch (error) {
      loading = undefined; // let the next validation try again
      throw error;
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

/**
 * Flowchart edge labels as Mermaid reads them. A label with punctuation, such
 * as `-->|PUT /events/{id}|`, breaks the parser unless it is quoted, and the
 * model rarely remembers (seen in Run #d4f0e8: rejected four times, then out
 * of turns). Quoting it changes nothing a person sees, so it is done here
 * rather than asked for again. Only flowcharts: other diagrams use `|` for
 * other things (`<|--` in a classDiagram).
 */
export function repairMermaid(source: string): string {
  if (!/^\s*(flowchart|graph)\b/.test(source)) return source;
  return source.replace(
    /((?:--|==|-\.)[-=.]*>?)\s*\|([^|\n]*)\|/g,
    (_whole, arrow: string, label: string) => {
      const text = label.trim().replace(/^"(.*)"$/, "$1");
      const plain = /^[\w ]*$/.test(text);
      return `${arrow}|${plain ? text : `"${text.replace(/"/g, "#quot;")}"`}|`;
    },
  );
}
