import { PrismaClient } from "@prisma/client";

/** Local SQLite file unless the environment names another database. */
export const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";

/** One client per process; tests reuse it (STRUCT-03: server only). */
export const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
