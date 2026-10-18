// Owner: WP6. Contract: INTERFACES.md §12 and Paperclip adapter-ui-parser.md 1.0.0.
// Self-contained: zero imports, no module-level side effects, never throws.

type UiTranscriptEntry =
  | { kind: "assistant" | "thinking" | "user" | "stderr" | "system" | "stdout"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; toolName: string; content: string; isError: boolean }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | { kind: "result"; ts: string; text: string; inputTokens: number; outputTokens: number; cachedTokens: number;
      costUsd: number; subtype: string; isError: boolean; errors: string[] };

type ParserState = { model: string };

const DEFAULT_PROVIDER_ERROR = "Prime provider request failed.";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function contentItems(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).filter((item): item is Record<string, unknown> => item !== null);
}

/** Joins `item[field]` of the content items whose `type` equals `type`; a string content counts as text. */
function joinItems(content: unknown, type: string, field: string): string {
  if (typeof content === "string") return type === "text" ? content : "";
  return contentItems(content).filter((item) => item.type === type).map((item) => asString(item[field])).join("");
}

function errorText(message: Record<string, unknown>): string {
  return asString(message.errorMessage).trim() || DEFAULT_PROVIDER_ERROR;
}

function parseEvent(state: ParserState, event: Record<string, unknown>, raw: string, ts: string): UiTranscriptEntry[] {
  const type = asString(event.type);
  return [{ kind: "stdout", ts, text: raw }]; // unknown event type
}

function parseWithState(state: ParserState, line: string, ts: string): UiTranscriptEntry[] {
  const raw = typeof line === "string" ? line.trim() : "";
  if (!raw) return [];
  if (raw.startsWith("[paperclip]")) return [{ kind: "system", ts, text: raw }];
  try {
    const event = asRecord(JSON.parse(raw));
    return event ? parseEvent(state, event, raw, ts) : [{ kind: "stdout", ts, text: raw }];
  } catch {
    return [{ kind: "stdout", ts, text: raw }];
  }
}

export function parseStdoutLine(line: string, ts: string): UiTranscriptEntry[] {
  return parseWithState({ model: "" }, line, ts);
}

export function createStdoutParser(): { parseLine(line: string, ts: string): UiTranscriptEntry[]; reset(): void } {
  const state: ParserState = { model: "" };
  return {
    parseLine: (line: string, ts: string) => parseWithState(state, line, ts),
    reset: () => {
      state.model = "";
    },
  };
}
