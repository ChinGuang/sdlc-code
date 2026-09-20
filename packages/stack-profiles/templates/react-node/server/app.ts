import express, { type Express } from "express";
import { prisma } from "./prisma.js";

/** The API. Slices add routers here; routes stay thin (STRUCT-02). */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", async (_request, response) => {
    const database = await prisma.$queryRaw`SELECT 1`
      .then(() => "up" as const)
      .catch(() => "down" as const);
    response.status(database === "up" ? 200 : 503).json({
      status: database === "up" ? "ok" : "degraded",
      database,
    });
  });

  return app;
}
