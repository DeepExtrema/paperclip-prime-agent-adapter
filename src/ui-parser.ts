// Owner: WP6. Contract: INTERFACES.md §12 and Paperclip adapter-ui-parser.md 1.0.0.
// Self-contained: zero imports, no module-level side effects, never throws.
// TAI-273 §4.4 (G4): every mapping is single-line and stateless, so parseStdoutLine and createStdoutParser give the same entries.

type UiTranscriptEntry =
  | { kind: "assistant" | "thinking" | "user" | "stderr" | "system" | "stdout"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; toolName: string; content: string; isError: boolean }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | { kind: "result"; ts: string; text: string; inputTokens: number; outputTokens: number; cachedTokens: number;
      costUsd: number; subtype: string; isError: boolean; errors: string[] };

const DEFAULT_PROVIDER_ERROR = "Prime provider request failed.";
/** Text, tool calls and tool results come from message_end only (INTERFACES §12, §16 A5); these would duplicate them. */
const IGNORED_EVENT_TYPES = ["agent_start", "turn_start", "turn_end", "message_start", "message_update", "tool_execution_start",
  "tool_execution_update", "tool_execution_end"];

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

function assistantEntries(message: Record<string, unknown>, ts: string): UiTranscriptEntry[] {
  const entries: UiTranscriptEntry[] = [];
  const thinking = joinItems(message.content, "thinking", "thinking");
  if (thinking) entries.push({ kind: "thinking", ts, text: thinking });
  const text = joinItems(message.content, "text", "text");
  if (text) entries.push({ kind: "assistant", ts, text });
  for (const item of contentItems(message.content)) {
    if (item.type !== "toolCall") continue;
    entries.push({ kind: "tool_call", ts, name: asString(item.name, "tool"), input: item.arguments ?? {}, toolUseId: asString(item.id) });
  }
  if (message.stopReason === "error") entries.push({ kind: "stderr", ts, text: errorText(message) });
  return entries;
}

/** Tool result from the toolResult-role message (INTERFACES §16 A5): text items, else the content as JSON. */
function toolResultEntry(message: Record<string, unknown>, ts: string): UiTranscriptEntry {
  const text = joinItems(message.content, "text", "text");
  return { kind: "tool_result", ts, toolUseId: asString(message.toolCallId), toolName: asString(message.toolName, "tool"),
    content: text || JSON.stringify(message.content ?? null), isError: message.isError === true };
}

/** Token usage of this run's assistant messages, counted once (L14); costUsd 0: Prime's cost is an estimate (§16 A3). */
function resultEntry(event: Record<string, unknown>, ts: string): UiTranscriptEntry {
  let [inputTokens, outputTokens, cachedTokens] = [0, 0, 0];
  const errors: string[] = [];
  for (const message of contentItems(event.messages)) {
    if (message.role !== "assistant") continue;
    const usage = asRecord(message.usage);
    inputTokens += asNumber(usage?.input);
    outputTokens += asNumber(usage?.output);
    cachedTokens += asNumber(usage?.cacheRead);
    if (message.stopReason === "error" && !errors.includes(errorText(message))) errors.push(errorText(message));
  }
  const isError = errors.length > 0;
  const text = isError ? "Run failed" : "Run completed";
  return { kind: "result", ts, text, inputTokens, outputTokens, cachedTokens, costUsd: 0, subtype: "end", isError, errors };
}

const PREVIEW_CHARS = 200;
const preview = (text: string) => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text);
const system = (ts: string, text: string): UiTranscriptEntry[] => [{ kind: "system", ts, text }];

/** rlm_child_update: the run log carries the parent's events only, so a child without rlmDepth is a direct child (depth 1). */
function childEntry(event: Record<string, unknown>, ts: string): UiTranscriptEntry[] {
  const child = asRecord(event.child) ?? {};
  const name = asString(child.sessionName) || asString(child.name) || asString(child.id) || asString(child.activeSessionId) || "child";
  const depth = typeof child.rlmDepth === "number" ? child.rlmDepth : 1;
  const answer = asString(child.answerPreview) || asString(child.answer);
  return system(ts, `subagent ${name} (depth ${depth}): ${asString(child.status, "update")}${answer ? ` — ${preview(answer)}` : ""}`);
}

function goalEntry(event: Record<string, unknown>, ts: string): UiTranscriptEntry[] {
  const goal = asRecord(event.goal) ?? asRecord(event.data) ?? event;
  const objective = asString(goal.objective);
  return system(ts, `goal ${asString(goal.status, "update")}${objective ? `: ${preview(objective)}` : ""}`);
}

function parseEvent(event: Record<string, unknown>, ts: string): UiTranscriptEntry[] {
  const type = asString(event.type);
  if (type === "session") return [{ kind: "init", ts, model: asString(event.model), sessionId: asString(event.id) }];
  if (type === "message_end") {
    const message = asRecord(event.message);
    if (message?.role === "assistant") return assistantEntries(message, ts);
    if (message?.role === "toolResult") return [toolResultEntry(message, ts)];
    if (message?.role === "user") {
      const text = joinItems(message.content, "text", "text");
      return text ? [{ kind: "user", ts, text }] : [];
    }
    return [];
  }
  if (type === "agent_end") return [resultEntry(event, ts)];
  if (IGNORED_EVENT_TYPES.includes(type)) return [];
  if (type === "rlm_child_update") return childEntry(event, ts);
  if (type === "auto_retry_start") {
    const reason = asString(event.errorMessage) || asString(event.reason);
    return system(ts, `provider retry ${asNumber(event.attempt)}/${asNumber(event.maxAttempts)} in ${asNumber(event.delayMs)} ms${reason ? `: ${preview(reason)}` : ""}`);
  }
  if (type === "auto_retry_end") {
    const reason = asString(event.finalError);
    return system(ts, `provider retry ${asNumber(event.attempt)} ${event.success === true ? "succeeded" : "failed"}${reason ? `: ${preview(reason)}` : ""}`);
  }
  if (type === "compaction_start") return system(ts, `compaction started${asString(event.reason) ? ` (${asString(event.reason)})` : ""}`);
  if (type === "compaction_end") {
    const error = asString(event.errorMessage);
    return system(ts, `compaction ${event.aborted === true ? "aborted" : error ? "not done" : "finished"}${error ? `: ${preview(error)}` : ""}`);
  }
  if (type === "goal_update" || type === "thread_goal_state") return goalEntry(event, ts);
  if (type === "model_change") {
    const model = asRecord(event.model);
    const name = model ? [asString(model.provider), asString(model.id)].filter(Boolean).join("/") : asString(event.model);
    return system(ts, `model changed${name ? ` to ${name}` : ""}`);
  }
  if (type === "error") return [{ kind: "stderr", ts, text: asString(event.message) || asString(event.error) || "Prime error" }];
  return system(ts, `Prime event ${type || "without a type"}`);
}

export function parseStdoutLine(line: string, ts: string): UiTranscriptEntry[] {
  try {
    const raw = typeof line === "string" ? line.trim() : "";
    if (!raw) return [];
    if (raw.startsWith("[paperclip]")) return [{ kind: "system", ts, text: raw }];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [{ kind: "stdout", ts, text: raw }];
    }
    const event = asRecord(parsed);
    return event ? parseEvent(event, ts) : [{ kind: "stdout", ts, text: raw }];
  } catch {
    return [];
  }
}

/** The same entries as parseStdoutLine, line by line (G4): no state crosses lines. */
export function createStdoutParser(): { parseLine(line: string, ts: string): UiTranscriptEntry[]; reset(): void } {
  return { parseLine: (line: string, ts: string) => parseStdoutLine(line, ts), reset: () => undefined };
}
