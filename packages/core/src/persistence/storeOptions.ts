import { randomUUID } from "node:crypto";
import type { Database } from "./database.js";

export type StoreOptions = {
  db: Database;
  newId?: () => string;
  /** ISO-8601 timestamp. */
  now?: () => string;
};

export type StoreContext = {
  db: Database;
  newId: () => string;
  now: () => string;
};

export function storeContext(options: StoreOptions): StoreContext {
  return {
    db: options.db,
    newId: options.newId ?? randomUUID,
    now: options.now ?? (() => new Date().toISOString()),
  };
}

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.name = "NotFoundError";
  }
}

/** SQLite has no boolean type; flags are stored as 0/1. */
export const toFlag = (value: boolean): number => (value ? 1 : 0);
export const fromFlag = (value: unknown): boolean => value === 1;
