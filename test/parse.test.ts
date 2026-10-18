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

describe("parsePrimeJsonl: session", () => {
  const SESSION_IDS: Record<RunName, string> = {
    run1: "01a14c2a-05ac-7659-a080-adb0fb06fb08",
    run2: "01a14c2a-5965-7269-8920-97d0da73b791",
    run3: "01a14c2a-5965-7269-8920-97d0da73b791",
    run4: "01a14c2a-a744-70f9-bdde-4882ae3a009c",
    run5: "01a14ea0-b577-7079-bda9-645362a2012f",
  };
  it.each(RUNS)("%s: sessionId and sessionCwd come from the session event", (run) => {
    const parsed = parsePrimeJsonl(fixture(run));
    expect(parsed.sessionId).toBe(SESSION_IDS[run]);
    expect(parsed.sessionCwd).toBe("/tmp/prime-local-check-we2ejug3/ws");
  });
  it("keeps the first session event", () => {
    const parsed = parsePrimeJsonl(
      jsonl({ type: "session", id: "first", cwd: "/a" }, { type: "session", id: "second", cwd: "/b" }),
    );
    expect(parsed.sessionId).toBe("first");
    expect(parsed.sessionCwd).toBe("/a");
  });
  it("reports null for a session event without id and cwd", () => {
    const parsed = parsePrimeJsonl(jsonl({ type: "session", id: 7 }));
    expect(parsed.sessionId).toBeNull();
    expect(parsed.sessionCwd).toBeNull();
  });
});

describe("parsePrimeJsonl: sawAgentEnd", () => {
  it.each(RUNS)("%s: sawAgentEnd is true", (run) => {
    expect(parsePrimeJsonl(fixture(run)).sawAgentEnd).toBe(true);
  });
  it("run4 without its agent_end line: sawAgentEnd is false", () => {
    const lines = fixture("run4").trimEnd().split("\n");
    expect(lines.at(-1)).toContain('"type":"agent_end"');
    expect(parsePrimeJsonl(lines.slice(0, -1).join("\n")).sawAgentEnd).toBe(false);
  });
});
