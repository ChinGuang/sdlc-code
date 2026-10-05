// SPDX-License-Identifier: MPL-2.0
import { useEffect, useId, useState } from "react";

/**
 * A Mermaid diagram, drawn by the mermaid library once it is needed: it is
 * large, and most pages never show a diagram. Until it is drawn, or if it
 * cannot be, the source is shown, which is still the diagram in words.
 * Mermaid's strict mode keeps a model's labels from carrying script.
 */
export function Mermaid({ source }: { source: string }) {
  const id = `mermaid-${useId().replace(/[^\w-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "dark",
        });
        const { svg: drawn } = await mermaid.render(id, source);
        if (live) setSvg(drawn);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [id, source]);

  if (svg)
    return (
      <figure
        className="diagram"
        // Drawn by mermaid in strict mode, which sanitises the labels.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  return (
    <figure className="diagram">
      {failed && (
        <figcaption className="faint small">
          This diagram could not be drawn; its source:
        </figcaption>
      )}
      <pre className="document-body">{source}</pre>
    </figure>
  );
}
