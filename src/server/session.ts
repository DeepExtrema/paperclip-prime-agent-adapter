// Owner: WP4. Contract: INTERFACES.md §7.
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { notImplemented } from "../errors.js";
import type { DecidePrimeResume, PrimeSessionParams, ReadPrimeSessionHeader } from "../types.js";

const SESSION_PARAM_KEYS = ["sessionId", "sessionFile", "cwd", "provider", "model", "agentDir"] as const;
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** The six PrimeSessionParams fields, or null when raw is not a plain object or any field is missing/empty. */
function pickPrimeSessionParams(raw: unknown): PrimeSessionParams | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const picked: Record<string, string> = {};
  for (const key of SESSION_PARAM_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (!isNonEmptyString(value)) return null;
    picked[key] = value;
  }
  return picked as unknown as PrimeSessionParams;
}

export const primeSessionCodec: AdapterSessionCodec = {
  deserialize: (raw) => pickPrimeSessionParams(raw) as Record<string, unknown> | null,
  serialize: (params) => pickPrimeSessionParams(params) as Record<string, unknown> | null,
  getDisplayId: (params) => (params && isNonEmptyString(params.sessionId) ? params.sessionId : null),
};

export const readPrimeSessionHeader: ReadPrimeSessionHeader = async () =>
  notImplemented("WP4", "readPrimeSessionHeader");

export const decidePrimeResume: DecidePrimeResume = () => notImplemented("WP4", "decidePrimeResume");
