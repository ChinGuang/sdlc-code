// SPDX-License-Identifier: MPL-2.0
/**
 * Server-sent events read from a stream of text (the WHATWG format): Node has
 * no EventSource of its own, and a terminal needs only the named messages.
 */
export type SseMessage = { event: string; id: string | null; data: string };

/** A parser fed text in any chunks; calls `onMessage` per complete message. */
export function createSseParser(
  onMessage: (message: SseMessage) => void,
): (chunk: string) => void {
  let buffer = "";
  let event = "message";
  let id: string | null = null;
  let data: string[] = [];

  const line = (text: string) => {
    if (text === "") {
      if (data.length > 0) onMessage({ event, id, data: data.join("\n") });
      event = "message";
      data = [];
      return;
    }
    if (text.startsWith(":")) return; // A comment, e.g. a keep-alive.
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  };

  // A CR ending one chunk may be the first half of a CRLF the next finishes.
  let endedOnCr = false;
  return (chunk) => {
    const text = endedOnCr && chunk.startsWith("\n") ? chunk.slice(1) : chunk;
    endedOnCr = text.endsWith("\r");
    buffer += text;
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? "";
    for (const one of lines) line(one);
  };
}
