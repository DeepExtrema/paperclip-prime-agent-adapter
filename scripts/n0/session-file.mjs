// N0: read a Prime session file (JSONL).
import fs from "node:fs";

export function entries(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { unparsed: line.slice(0, 200) }; } });
}

const flat = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b.text ?? b.content ?? "").join("") : JSON.stringify(content));

/** The text of every tool result in the file, in order. */
export function toolResults(file) {
  return entries(file).filter((e) => e.type === "message" && (e.message?.role === "toolResult" || e.message?.role === "tool")).map((e) => flat(e.message.content).slice(0, 4000));
}

/** Entry types and counts, for orientation. */
export function shape(file) {
  const counts = {};
  for (const e of entries(file)) {
    const key = e.type === "message" ? `message:${e.message?.role}` : e.type ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
