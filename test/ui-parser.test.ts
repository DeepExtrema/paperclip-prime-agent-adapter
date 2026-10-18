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

describe("session event", () => {
  it("maps session to init with the session id", () => {
    expect(parseStdoutLine(line("run2", 1), TS)).toEqual([{ kind: "init", ts: TS, model: "", sessionId: "01a14c2a-5965-7269-8920-97d0da73b791" }]);
  });
});

describe("message_end: user and hidden roles", () => {
  it("maps a user message to user with its text", () => {
    const text = "Remember the code word PELICAN. Reply with exactly OK.";
    expect(parseStdoutLine(line("run2", 7), TS)).toEqual([{ kind: "user", ts: TS, text }]);
  });
  it("returns no entries for custom (harness_digest) messages", () => expect(parseStdoutLine(line("run2", 5), TS)).toEqual([]));
});

describe("message_end: assistant", () => {
  it("maps assistant text to one assistant entry", () => {
    expect(parseStdoutLine(line("run2", 12), TS)).toEqual([{ kind: "assistant", ts: TS, text: "OK" }]);
  });
  it("maps each toolCall item to a tool_call after the text", () => {
    expect(parseStdoutLine(line("run4", 27), TS)).toEqual([
      { kind: "assistant", ts: TS, text: "I'll compute 6*7 and get the Paperclip check phrase for you." },
      { kind: "tool_call", ts: TS, name: "ipython", input: { code: "\n# Compute 6*7\nresult = 6 * 7\nprint(result)\n" },
        toolUseId: "toolu_01D1iEqtRH3v2sCKAY59YkLF" },
    ]);
  });
});
