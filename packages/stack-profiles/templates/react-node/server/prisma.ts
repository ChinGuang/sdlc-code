import { PrismaClient } from "@prisma/client";

/** One client per process, on the database the environment names (STRUCT-03). */
export const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL ?? "file:./dev.db",
});
