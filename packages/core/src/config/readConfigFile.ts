import { existsSync, readFileSync } from "node:fs";
import { AgentConfigError } from "./agentConfig.js";

/** Reads the optional JSON config file; undefined if it does not exist. */
export function readConfigFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new AgentConfigError([`${path}: not valid JSON (${String(error)})`]);
  }
}
