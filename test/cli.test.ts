import { readFileSync } from "node:fs";
import pc from "picocolors";
import { describe, expect, it, vi } from "vitest";
import { printPrimeStreamEvent } from "../src/cli/index.js";

const runLines = (run: string): string[] =>
  readFileSync(new URL(`./fixtures/prime-jsonl/${run}.jsonl`, import.meta.url), "utf8").split("\n");
const line = (run: string, n: number): string => runLines(run)[n - 1] ?? "";
const last = (run: string): string => runLines(run).filter((l) => l.trim()).at(-1) ?? "";

function printed(raw: string, debug = false): unknown[][] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    printPrimeStreamEvent(raw, debug);
    return [...spy.mock.calls];
  } finally {
    spy.mockRestore();
  }
}

describe("printPrimeStreamEvent", () => {
  it("prints the session, user and assistant lines of run2", () => {
    expect(printed(line("run2", 1))).toEqual([[pc.blue("Prime session 01a14c2a-5965-7269-8920-97d0da73b791")]]);
    expect(printed(line("run2", 7))).toEqual([[pc.cyan("user: Remember the code word PELICAN. Reply with exactly OK.")]]);
    expect(printed(line("run2", 12))).toEqual([[pc.green("assistant: OK")]]);
  });
  it("prints a tool call with its arguments and the tool result", () => {
    expect(printed(line("run4", 27))).toEqual([
      [pc.green("assistant: I'll compute 6*7 and get the Paperclip check phrase for you.")],
      [pc.yellow("tool_call: ipython")],
      [pc.gray(JSON.stringify({ code: "\n# Compute 6*7\nresult = 6 * 7\nprint(result)\n" }, null, 2))],
    ]);
    expect(printed(line("run4", 31))).toEqual([[pc.gray("tool_result ipython: 42")]]);
  });
  it("prints provider errors and the failed result in red", () => {
    expect(printed(line("run1", 9))).toEqual([[pc.red("error: No AWS credentials available for Bedrock")]]);
    expect(printed(last("run1"))).toEqual([[pc.red("Run failed: input 0, output 0, cached 0 tokens")]]);
  });
  it("prints the usage summary of a completed run in blue", () => {
    expect(printed(last("run4"))).toEqual([[pc.blue("Run completed: input 15, output 237, cached 21440 tokens")]]);
  });
  it("prints [paperclip] lines in blue, other lines as they are, and skips blank lines", () => {
    expect(printed("[paperclip] Starting a fresh Prime session")).toEqual([[pc.blue("[paperclip] Starting a fresh Prime session")]]);
    expect(printed("plain text")).toEqual([["plain text"]]);
    expect(printed('{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000}')).toEqual([[pc.blue("provider retry 1/3 in 2000 ms")]]);
    expect(printed("   ")).toEqual([]);
  });
  it("prints ignored stream events only in debug mode, in gray", () => {
    for (const raw of [line("run2", 2), line("run2", 9), line("run2", 13), line("run4", 28), line("run4", 29), line("run2", 5)]) {
      expect(printed(raw, false)).toEqual([]);
      expect(printed(raw, true)).toEqual([[pc.gray(raw)]]);
    }
  });
});
