import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { STATUS_CODES } from "node:http";
import { prisma } from "./prisma.js";

/**
 * The API. A Slice adds its routes through `register`, so they sit before the
 * error handler; routes stay thin and validate their input with zod (SEC-02),
 * then call a service function that holds the logic (STRUCT-02).
 */
export function createApp(register?: (app: Express) => void): Express {
  const app = express();
  app.use(express.json());

  app.get(
    "/health",
    route(async (_request, response) => {
      const database = await prisma
        .$queryRaw`SELECT 1`.then(() => "up" as const)
        .catch(() => "down" as const);
      response.status(database === "up" ? 200 : 503).json({
        status: database === "up" ? "ok" : "degraded",
        database,
      });
    }),
  );

  register?.(app);
  app.use(errorHandler);
  return app;
}

/**
 * Wraps an async route so a rejected promise reaches the error handler.
 * Express 4 ignores rejections otherwise, and the request hangs.
 */
export function route(
  handler: (request: Request, response: Response) => Promise<unknown>,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };
}

/**
 * Last resort for a route that threw: the client learns nothing about the
 * inside of the server (SEC-03), and the log keeps the detail.
 */
function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (response.headersSent) {
    next(error);
    return;
  }
  // The client's own mistake, e.g. a body that is not JSON (express.json()
  // marks it 400): said as such, by its status's name and nothing more.
  const status = clientErrorStatus(error);
  if (status !== null) {
    response.status(status).json({ error: STATUS_CODES[status] });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "Internal Server Error" });
}

function clientErrorStatus(error: unknown): number | null {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? error.status
      : null;
  return typeof status === "number" && status >= 400 && status < 500
    ? status
    : null;
}
