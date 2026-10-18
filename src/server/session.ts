// Owner: WP4. Contract: INTERFACES.md §7.
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
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

export const readPrimeSessionHeader: ReadPrimeSessionHeader = async (sessionFile) => {
  try {
    const text = await fs.readFile(sessionFile, "utf8");
    const line = text.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!line) return null;
    const raw: unknown = JSON.parse(line);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const { type, id, cwd } = raw as Record<string, unknown>;
    if (type !== "session" || !isNonEmptyString(id)) return null;
    return { id, cwd: isNonEmptyString(cwd) ? cwd : null };
  } catch {
    return null;
  }
};

export const decidePrimeResume: DecidePrimeResume = ({ saved, current, header }) => {
  if (saved === null) return { resume: false, reason: "no_saved_session" };
  if (path.resolve(saved.cwd) !== path.resolve(current.cwd)) return { resume: false, reason: "cwd_mismatch" };
  if (saved.provider !== current.provider || saved.model !== current.model) return { resume: false, reason: "model_mismatch" };
  if (path.resolve(saved.agentDir) !== path.resolve(current.agentDir)) return { resume: false, reason: "agent_dir_mismatch" };
  if (header === null) return { resume: false, reason: "session_file_missing" };
  if (header.id !== saved.sessionId || (header.cwd !== null && path.resolve(header.cwd) !== path.resolve(current.cwd))) return { resume: false, reason: "session_header_mismatch" };
  return { resume: true, sessionFile: saved.sessionFile };
};
