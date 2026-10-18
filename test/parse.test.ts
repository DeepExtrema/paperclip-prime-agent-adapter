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

describe("parsePrimeJsonl: usage", () => {
  const USAGE: Record<RunName, ParsedPrimeOutput["usage"]> = {
    run1: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, totalTokens: 0, reportedCostUsd: 0 },
    run2: { inputTokens: 3, outputTokens: 4, cachedInputTokens: 0, cacheWriteTokens: 10553, totalTokens: 10560, reportedCostUsd: 0 },
    run3: { inputTokens: 3, outputTokens: 6, cachedInputTokens: 10553, cacheWriteTokens: 19, totalTokens: 10581, reportedCostUsd: 0 },
    run4: { inputTokens: 15, outputTokens: 237, cachedInputTokens: 21440, cacheWriteTokens: 10964, totalTokens: 32656, reportedCostUsd: 0 },
    run5: { inputTokens: 3, outputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 10559, totalTokens: 10567, reportedCostUsd: 0.01322675 },
  };
  it.each(RUNS)("%s: usage is the sum over assistant turn_end messages only", (run) => {
    expect(parsePrimeJsonl(fixture(run)).usage).toEqual(USAGE[run]);
  });
  it("ignores usage on message_end and message_update", () => {
    const usage = { input: 5, output: 5, cacheRead: 5, cacheWrite: 5, totalTokens: 20, cost: { total: 1 } };
    const stdout = jsonl(
      { type: "message_update", message: { role: "assistant", usage } },
      { type: "message_end", message: { role: "assistant", content: [], usage } },
    );
    expect(parsePrimeJsonl(stdout).usage).toBeNull();
  });
  it("stays null when the assistant turn_end has no usage object", () => {
    const stdout = jsonl({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
    expect(parsePrimeJsonl(stdout).usage).toBeNull();
  });
  it("counts missing or non-numeric usage fields as 0", () => {
    const stdout = jsonl({ type: "turn_end", message: { role: "assistant", usage: { input: 2, output: "x", cost: null } } });
    expect(parsePrimeJsonl(stdout).usage).toEqual({
      inputTokens: 2,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      reportedCostUsd: 0,
    });
  });
});

describe("parsePrimeJsonl: assistant turns", () => {
  const TURNS: Record<RunName, Pick<ParsedPrimeOutput, "messages" | "lastStopReason" | "provider" | "model">> = {
    run1: { messages: [], lastStopReason: "error", provider: "amazon-bedrock", model: "fixture-amazon-bedrock-0" },
    run2: { messages: ["OK"], lastStopReason: "stop", provider: "anthropic", model: "claude-haiku-4-5" },
    run3: { messages: ["PELICAN"], lastStopReason: "stop", provider: "anthropic", model: "claude-haiku-4-5" },
    run4: {
      messages: ["I'll compute 6*7 and get the Paperclip check phrase for you.", "Now let me read the Paperclip check skill to get the phrase:", "**42 HERON-42**"],
      lastStopReason: "stop",
      provider: "anthropic",
      model: "claude-haiku-4-5",
    },
    run5: { messages: ["DASH"], lastStopReason: "stop", provider: "anthropic", model: "claude-haiku-4-5" },
  };
  it.each(RUNS)("%s: messages, lastStopReason, provider and model come from assistant turn_end", (run) => {
    const parsed = parsePrimeJsonl(fixture(run));
    expect({
      messages: parsed.messages,
      lastStopReason: parsed.lastStopReason,
      provider: parsed.provider,
      model: parsed.model,
    }).toEqual(TURNS[run]);
  });
  it("joins the text items of one message and skips whitespace-only text", () => {
    const stdout = jsonl(
      { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "a" }, { type: "toolCall", id: "t" }, { type: "text", text: "b" }] } },
      { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "  " }] } },
    );
    expect(parsePrimeJsonl(stdout).messages).toEqual(["ab"]);
  });
});

describe("parsePrimeJsonl: finalMessage", () => {
  const FINAL: Record<RunName, string | null> = {
    run1: null,
    run2: "OK",
    run3: "PELICAN",
    run4: "**42 HERON-42**",
    run5: "DASH",
  };
  it.each(RUNS)("%s: finalMessage is the last assistant text of agent_end", (run) => {
    expect(parsePrimeJsonl(fixture(run)).finalMessage).toBe(FINAL[run]);
  });
  it("skips a harness_digest custom message after the last assistant message", () => {
    const stdout = jsonl({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "custom", customType: "harness_digest", content: "[harness-digest]", display: false },
      ],
    });
    expect(parsePrimeJsonl(stdout).finalMessage).toBe("answer");
  });
  it("falls back to the last turn_end text without agent_end", () => {
    const stdout = jsonl(
      { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
      { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "two" }] } },
    );
    expect(parsePrimeJsonl(stdout).finalMessage).toBe("two");
  });
  it("falls back to the last turn_end text when the last agent_end assistant message has no text", () => {
    const stdout = jsonl(
      { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "earlier" }] } },
      { type: "agent_end", messages: [{ role: "assistant", content: [] }] },
    );
    expect(parsePrimeJsonl(stdout).finalMessage).toBe("earlier");
  });
});

describe("parsePrimeJsonl: provider failures", () => {
  it.each(RUNS)("%s: errors hold each provider failure once", (run) => {
    const expected = run === "run1" ? ["No AWS credentials available for Bedrock"] : [];
    expect(parsePrimeJsonl(fixture(run)).errors).toEqual(expected);
  });
  it("uses the fallback text when errorMessage is missing", () => {
    const stdout = jsonl({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
    expect(parsePrimeJsonl(stdout).errors).toEqual(["Prime provider request failed."]);
  });
  it("reads failures from agent_end messages and ignores non-assistant roles", () => {
    const stdout = jsonl(
      { type: "message_end", message: { role: "user", stopReason: "error", errorMessage: "not mine" } },
      {
        type: "agent_end",
        messages: [
          { role: "assistant", stopReason: "error", errorMessage: "first" },
          { role: "assistant", stopReason: "error", errorMessage: "second" },
        ],
      },
    );
    expect(parsePrimeJsonl(stdout).errors).toEqual(["first", "second"]);
  });
});

describe("parsePrimeJsonl: error events", () => {
  it("adds the message of error events once and ignores empty ones", () => {
    const stdout = jsonl(
      { type: "error", message: "Connection to model provider lost" },
      { type: "error", message: "  " },
      { type: "error" },
      { type: "error", message: "Connection to model provider lost" },
    );
    expect(parsePrimeJsonl(stdout).errors).toEqual(["Connection to model provider lost"]);
  });
});

describe("parsePrimeJsonl: auto_retry_end", () => {
  it("adds finalError when the retries failed", () => {
    const stdout = jsonl({ type: "auto_retry_end", success: false, attempt: 3, finalError: "API error (429): RESOURCE_EXHAUSTED" });
    expect(parsePrimeJsonl(stdout).errors).toEqual(["API error (429): RESOURCE_EXHAUSTED"]);
  });
  it("uses the fallback text when finalError is missing", () => {
    const stdout = jsonl({ type: "auto_retry_end", attempt: 3 });
    expect(parsePrimeJsonl(stdout).errors).toEqual(["Prime exhausted automatic retries without producing a response."]);
  });
  it("adds nothing when the retry succeeded", () => {
    const stdout = jsonl({ type: "auto_retry_end", success: true, attempt: 2 });
    expect(parsePrimeJsonl(stdout).errors).toEqual([]);
  });
});
