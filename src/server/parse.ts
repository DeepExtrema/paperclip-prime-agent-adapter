// Owner: WP2. Contract: INTERFACES.md §6. Replace the stub bodies; keep the typed exports.
import type { IsPrimeUnknownSessionError, ParsedPrimeOutput, ParsePrimeJsonl } from "../types.js";

type JsonObject = Record<string, unknown>;

const PROVIDER_FAILURE_FALLBACK = "Prime provider request failed.";
const RETRY_EXHAUSTED_FALLBACK = "Prime exhausted automatic retries without producing a response.";

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

/** Text of the last assistant message in an agent_end `messages` array, or null if there is none. */
function lastAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = assistantMessage(messages[index]);
    if (message) return contentText(message.content);
  }
  return null;
}

function addError(result: ParsedPrimeOutput, message: string): void {
  if (!result.errors.includes(message)) result.errors.push(message);
}

/** Records an assistant message that ended with stopReason "error" (pi-local parse.ts:57-69). */
function recordProviderFailure(result: ParsedPrimeOutput, value: unknown): void {
  const message = assistantMessage(value);
  if (message?.stopReason !== "error") return;
  addError(result, asText(message.errorMessage).trim() || PROVIDER_FAILURE_FALLBACK);
}

/** Joined text items of a toolResult `content`; a string as is; otherwise its JSON (INTERFACES §6, §16 A5). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  const hasText = Array.isArray(content) && content.some((item) => asObject(item)?.type === "text");
  return hasText ? contentText(content) : JSON.stringify(content ?? null);
}

/** Tool calls from assistant `toolCall` items; result and isError from `toolResult` messages (INTERFACES §16 A1, A5). */
function recordToolMessage(result: ParsedPrimeOutput, value: unknown): void {
  const message = asObject(value);
  if (message?.role === "assistant" && Array.isArray(message.content)) {
    for (const item of message.content) {
      const part = asObject(item);
      const toolCallId = asText(part?.id);
      if (part?.type !== "toolCall" || !toolCallId) continue;
      if (result.toolCalls.some((call) => call.toolCallId === toolCallId)) continue;
      result.toolCalls.push({ toolCallId, toolName: asText(part.name), args: part.arguments ?? null, result: null, isError: false });
    }
  }
  if (message?.role !== "toolResult") return;
  const toolCallId = asText(message.toolCallId);
  if (!toolCallId) return;
  let call = result.toolCalls.find((candidate) => candidate.toolCallId === toolCallId);
  if (!call) {
    call = { toolCallId, toolName: asText(message.toolName), args: null, result: null, isError: false };
    result.toolCalls.push(call);
  }
  call.result = toolResultText(message.content);
  call.isError = message.isError === true;
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
  let agentEndText: string | null = null;

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
      case "message_end":
        recordToolMessage(result, event.message);
        recordProviderFailure(result, event.message);
        break;
      case "turn_end": {
        recordProviderFailure(result, event.message);
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
        if (Array.isArray(event.messages)) {
          for (const message of event.messages) recordProviderFailure(result, message);
        }
        agentEndText = lastAssistantText(event.messages);
        break;
      case "error": {
        const message = asText(event.message).trim();
        if (message) addError(result, message);
        break;
      }
      case "auto_retry_end":
        if (event.success !== true) addError(result, asText(event.finalError).trim() || RETRY_EXHAUSTED_FALLBACK);
        break;
      default:
        break;
    }
  }

  result.finalMessage = agentEndText?.trim() ? agentEndText : (result.messages.at(-1) ?? null);
  return result;
};

/** Same patterns as pi-local isPiUnknownSessionError (parse.ts:234-242); matches Prime's "No session found matching '<id>'." */
export const isPrimeUnknownSessionError: IsPrimeUnknownSessionError = (stdout, stderr) => {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown\s+session|session\s+not\s+found|session\s+.*\s+not\s+found|no\s+session/i.test(haystack);
};
