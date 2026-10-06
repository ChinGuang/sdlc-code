// SPDX-License-Identifier: MPL-2.0
/**
 * A stand-in for apps/server over real HTTP: it records every request and
 * answers from what a test gives it, so the CLI's own HTTP client, SSE reader
 * and all, is what the tests exercise.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type Recorded = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
};

export type Route = (request: {
  method: string;
  path: string;
  body: unknown;
}) =>
  | {
      status?: number;
      json: unknown;
      raw?: string;
      /** Replaces the JSON content type, e.g. for a download. */
      headers?: Record<string, string>;
    }
  | {
      events: Array<{ type: string; [field: string]: unknown }>;
      /** Close the stream after them, as a server that stopped would. */
      end?: boolean;
    }
  | undefined;

export async function mockServer(route: Route) {
  const requests: Recorded[] = [];
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const text = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });
      const body = text ? (JSON.parse(text) as unknown) : undefined;
      const path = req.url ?? "/";
      requests.push({
        method: req.method ?? "GET",
        path,
        body,
        authorization: req.headers.authorization,
      });
      const answer = route({ method: req.method ?? "GET", path, body });
      if (!answer) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ statusCode: 404, message: `No route ${path}` }),
        );
        return;
      }
      if ("events" in answer) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Split across writes, as a real stream may be.
        for (const [index, event] of answer.events.entries()) {
          const message = `id: ${index + 1}\nevent: ${event.type}\ndata: ${JSON.stringify({ runId: "r", seq: index + 1, happenedAt: "2026-09-30T10:00:00.000Z", ...event })}\n\n`;
          res.write(message.slice(0, 10));
          res.write(message.slice(10));
        }
        // Held open, as the server's stream is: the client must stop by itself.
        if (answer.end) res.end();
        return;
      }
      res.writeHead(answer.status ?? 200, {
        "content-type": "application/json",
        ...answer.headers,
      });
      res.end(answer.raw ?? JSON.stringify(answer.json));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
