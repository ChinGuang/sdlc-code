// SPDX-License-Identifier: MPL-2.0
/**
 * Enough Markdown for what the System Design Agent writes: headings,
 * paragraphs, lists, code and Mermaid diagrams. It builds React elements and
 * never HTML, so nothing a model wrote can inject markup into the page.
 */
import type { ReactNode } from "react";
import { Mermaid } from "./Mermaid.js";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; language: string; code: string };

export function blocksOf(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0)
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = /^\s*```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (index += 1; index < lines.length; index += 1) {
        if (/^\s*```\s*$/.test(lines[index]!)) break;
        code.push(lines[index]!);
      }
      blocks.push({
        kind: "code",
        language: fence[1] ?? "",
        code: code.join("\n"),
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        text: heading[2]!.trim(),
      });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const last = blocks.at(-1);
      if (last?.kind === "list" && last.ordered === ordered)
        last.items.push(item[3]!);
      else blocks.push({ kind: "list", ordered, items: [item[3]!] });
      continue;
    }
    if (line.trim() === "") flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** `code`, **bold**, *italic* and [links](https://…); anything else as text. */
export function inline(text: string): ReactNode[] {
  // Emphasis only at word edges: created_at and 2*3*4 are not italic.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|((?<!\w)\*[^*\s][^*]*\*(?!\w)|(?<!\w)_[^_\s][^_]*_(?!\w))|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > last) nodes.push(text.slice(last, at));
    const [whole] = match;
    if (match[1]) nodes.push(<code key={at}>{whole.slice(1, -1)}</code>);
    else if (match[2])
      nodes.push(<strong key={at}>{whole.slice(2, -2)}</strong>);
    else if (match[3]) nodes.push(<em key={at}>{whole.slice(1, -1)}</em>);
    else {
      const [, label, href] = /^\[([^\]]+)\]\((.+)\)$/.exec(whole)!;
      nodes.push(
        <a key={at} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    }
    last = at + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      {blocksOf(source).map((block, index) => {
        switch (block.kind) {
          case "heading": {
            // The page already has an h1 and the card an h2.
            const Tag = `h${Math.min(block.level + 2, 6)}` as "h3";
            return <Tag key={index}>{inline(block.text)}</Tag>;
          }
          case "paragraph":
            return <p key={index}>{inline(block.text)}</p>;
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={index}>
                {block.items.map((item, at) => (
                  <li key={at}>{inline(item)}</li>
                ))}
              </Tag>
            );
          }
          case "code":
            return block.language === "mermaid" ? (
              // A new source is a new diagram, not the old one kept on screen.
              <Mermaid key={`${index}:${block.code}`} source={block.code} />
            ) : (
              <pre key={index} className="document-body">
                {block.code}
              </pre>
            );
        }
      })}
    </div>
  );
}
