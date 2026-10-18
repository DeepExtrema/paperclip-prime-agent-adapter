// Owner: WP2. Contract: INTERFACES.md §6. Replace the stub bodies; keep the typed exports.
import { notImplemented } from "../errors.js";
import type { IsPrimeUnknownSessionError, ParsedPrimeOutput, ParsePrimeJsonl } from "../types.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One stdout line as a JSON object, or null for blank, malformed and non-object lines. */
function parseEventLine(line: string): JsonObject | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return asObject(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export const parsePrimeJsonl: ParsePrimeJsonl = (stdout) => {
  const result: ParsedPrimeOutput = {
    sessionId: null,
    sessionCwd: null,
    messages: [],
    finalMessage: null,
    errors: [],
    lastStopReason: null,
    provider: null,
    model: null,
    usage: null,
    toolCalls: [],
    sawAgentEnd: false,
  };

  let sawSession = false;

  for (const line of stdout.split(/\r?\n/)) {
    const event = parseEventLine(line);
    if (!event) continue;
    switch (event.type) {
      case "session":
        if (!sawSession) {
          sawSession = true;
          result.sessionId = asText(event.id) || null;
          result.sessionCwd = asText(event.cwd) || null;
        }
        break;
      case "agent_end":
        result.sawAgentEnd = true;
        break;
      default:
        break;
    }
  }

  return result;
};

export const isPrimeUnknownSessionError: IsPrimeUnknownSessionError = () =>
  notImplemented("WP2", "isPrimeUnknownSessionError");
