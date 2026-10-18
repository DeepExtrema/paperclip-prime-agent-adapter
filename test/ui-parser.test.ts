import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createStdoutParser, parseStdoutLine } from "../src/ui-parser.js";

const TS = "2026-10-18T00:00:00.000Z";
const runLines = (run: string): string[] =>
  readFileSync(new URL(`./fixtures/prime-jsonl/${run}.jsonl`, import.meta.url), "utf8").split("\n");
const line = (run: string, n: number): string => runLines(run)[n - 1] ?? "";
const last = (run: string): string => runLines(run).filter((l) => l.trim()).at(-1) ?? "";

describe("line classification", () => {
  it("returns no entries for a blank line", () => expect(parseStdoutLine("   ", TS)).toEqual([]));
  it("maps a [paperclip] line to system", () => {
    const text = "[paperclip] Starting a fresh Prime session";
    expect(parseStdoutLine(`${text}\n`, TS)).toEqual([{ kind: "system", ts: TS, text }]);
  });
  it("maps a non-JSON line and a non-object JSON line to stdout", () => {
    expect(parseStdoutLine("plain text", TS)).toEqual([{ kind: "stdout", ts: TS, text: "plain text" }]);
    expect(parseStdoutLine("[1,2]", TS)).toEqual([{ kind: "stdout", ts: TS, text: "[1,2]" }]);
  });
  it("maps an unknown event type to stdout with the trimmed line", () => {
    const raw = '{"type":"auto_retry_start","attempt":1}';
    expect(parseStdoutLine(` ${raw} `, TS)).toEqual([{ kind: "stdout", ts: TS, text: raw }]);
  });
});
