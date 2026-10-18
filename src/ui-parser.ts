// Owner: WP6. Contract: INTERFACES.md §12. Self-contained: zero imports, no side effects, never throws.
// WP0 stub: passes every non-empty line through as raw stdout.

type StubTranscriptEntry = { kind: "stdout"; ts: string; text: string };

export function parseStdoutLine(line: string, ts: string): StubTranscriptEntry[] {
  const text = typeof line === "string" ? line.trim() : "";
  return text ? [{ kind: "stdout", ts, text }] : [];
}

export function createStdoutParser(): {
  parseLine(line: string, ts: string): StubTranscriptEntry[];
  reset(): void;
} {
  return {
    parseLine: parseStdoutLine,
    reset() {},
  };
}
