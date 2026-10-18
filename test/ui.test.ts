import { readFileSync } from "node:fs";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { describe, expect, it } from "vitest";
import { parseStdoutLine } from "../src/ui-parser.js";
import { buildPrimeLocalConfig, parsePrimeStdoutLine } from "../src/ui/index.js";

const TS = "2026-10-18T00:00:00.000Z";

describe("parsePrimeStdoutLine", () => {
  it("returns the same entries as the zero-import ui-parser for every run4 line", () => {
    const lines = readFileSync(new URL("./fixtures/prime-jsonl/run4.jsonl", import.meta.url), "utf8").split("\n");
    for (const l of lines) expect(parsePrimeStdoutLine(l, TS)).toEqual(parseStdoutLine(l, TS));
  });
});
