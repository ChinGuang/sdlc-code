import { createServer, type Server, type ServerResponse } from "node:http";
import { AGENT_ROLES } from "@sdlc-code/core";

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** Local-only HTTP API. T21 adds runs, gates and the SSE stream. */
export function createAppServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok", agentRoles: AGENT_ROLES.length });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  });
}
