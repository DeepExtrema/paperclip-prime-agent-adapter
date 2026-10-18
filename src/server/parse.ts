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

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function assistantMessage(value: unknown): JsonObject | null {
  const message = asObject(value);
  return message?.role === "assistant" ? message : null;
}

/** Adds one assistant message's usage; creates the totals on the first usage object seen. */
function addUsage(result: ParsedPrimeOutput, value: unknown): void {
  const usage = asObject(value);
  if (!usage) return;
  const totals = (result.usage ??= {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    reportedCostUsd: 0,
  });
  totals.inputTokens += asCount(usage.input);
  totals.outputTokens += asCount(usage.output);
  totals.cachedInputTokens += asCount(usage.cacheRead);
  totals.cacheWriteTokens += asCount(usage.cacheWrite);
  totals.totalTokens += asCount(usage.totalTokens);
  totals.reportedCostUsd += asCount(asObject(usage.cost)?.total);
}

/** Joined text items of a content array; a string content is returned as is (pi-local parse.ts:22-29). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const item of content) {
    const part = asObject(item);
    if (part?.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text;
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
      case "turn_end": {
        const message = assistantMessage(event.message);
        if (!message) break;
        addUsage(result, message.usage);
        const text = contentText(message.content);
        if (text.trim()) result.messages.push(text);
        result.lastStopReason = asText(message.stopReason) || null;
        result.provider = asText(message.provider) || null;
        result.model = asText(message.model) || null;
        break;
      }
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
