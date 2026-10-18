import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPrimeUnknownSessionError, parsePrimeJsonl } from "../src/server/parse.js";
import type { ParsedPrimeOutput } from "../src/types.js";

const RUNS = ["run1", "run2", "run3", "run4", "run5"] as const;
type RunName = (typeof RUNS)[number];

function fixture(run: RunName): string {
  return readFileSync(new URL(`./fixtures/prime-jsonl/${run}.jsonl`, import.meta.url), "utf8");
}

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

const EMPTY: ParsedPrimeOutput = {
  sessionId: null, sessionCwd: null, messages: [], finalMessage: null, errors: [], lastStopReason: null,
  provider: null, model: null, usage: null, toolCalls: [], sawAgentEnd: false,
};

describe("parsePrimeJsonl: lines it cannot use", () => {
  it("returns the empty result for blank, malformed, non-object, unknown and custom lines", () => {
    const stdout = [
      "",
      "   ",
      "not json",
      '{"type":"turn_end","message":',
      "42",
      "null",
      "[1,2]",
      '"text"',
      JSON.stringify({ type: "compaction_start" }),
      JSON.stringify({ noType: true }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }),
      JSON.stringify({
        type: "message_end",
        message: { role: "custom", customType: "harness_digest", content: "[harness-digest]\n\nmemories", display: false },
      }),
    ].join("\n");
    expect(parsePrimeJsonl(stdout)).toEqual(EMPTY);
  });
  it("parses run2 the same with noise lines, CRLF line ends and a cut-off last line", () => {
    const clean = fixture("run2");
    const noisy = clean.split("\n").flatMap((line) => [line, "garbage {"]).join("\r\n") + '\r\n{"type":"agent_e';
    expect(parsePrimeJsonl(noisy)).toEqual(parsePrimeJsonl(clean));
  });
});
