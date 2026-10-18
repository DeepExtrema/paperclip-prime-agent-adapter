import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createServerAdapter, type } from "../src/index.js";
import { createStdoutParser, parseStdoutLine } from "../src/ui-parser.js";
import { PRIME_ADAPTER_TYPE } from "../src/types.js";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

describe("server module contract (INTERFACES.md §1)", () => {
  it("exposes the plugin-loader shape and capability flags", () => {
    const adapter = createServerAdapter();
    expect(type).toBe("prime_agent_local");
    expect(adapter.type).toBe(PRIME_ADAPTER_TYPE);
    for (const fn of [
      adapter.execute,
      adapter.testEnvironment,
      adapter.listSkills,
      adapter.syncSkills,
      adapter.listModels,
      adapter.refreshModels,
      adapter.detectModel,
      adapter.getConfigSchema,
    ]) {
      expect(typeof fn).toBe("function");
    }
    expect(adapter.sessionCodec).toBeDefined();
    expect(adapter.models).toEqual([]);
    expect(adapter.supportsLocalAgentJwt).toBe(true);
    expect(adapter.supportsInstructionsBundle).toBe(true);
    expect(adapter.instructionsPathKey).toBe("instructionsFilePath");
    expect(adapter.requiresMaterializedRuntimeSkills).toBe(true);
    expect(adapter.runtimeToolDelivery).toBe("environment");
  });

  it("declares the external-adapter package fields", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.type).toBe("module");
    expect(pkg.paperclip).toEqual({ adapterUiParser: "1.0.0" });
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./cli", "./server", "./ui", "./ui-parser"]);
  });
});

describe("ui-parser contract (INTERFACES.md §12)", () => {
  it("has no imports", () => {
    const source = readFileSync(new URL("../src/ui-parser.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it("returns arrays and never throws on the captured runs", () => {
    const parser = createStdoutParser();
    for (const run of ["run1", "run2", "run3", "run4"]) {
      const lines = readFileSync(fixture(`prime-jsonl/${run}.jsonl`), "utf8").split("\n");
      for (const line of [...lines, "", "not json", "[paperclip] note"]) {
        expect(Array.isArray(parser.parseLine(line, "2026-10-18T00:00:00.000Z"))).toBe(true);
        expect(Array.isArray(parseStdoutLine(line, "2026-10-18T00:00:00.000Z"))).toBe(true);
      }
      parser.reset();
    }
  });
});

describe("captured fixtures (INTERFACES.md §13)", () => {
  const pinned: Record<string, string> = {
    "run1.jsonl": "d3694d77ebc3fbce998918c0f0b52f920021461030249a4113e7d604faecb1ce",
    "run2.jsonl": "c95fdf9376b4f7d8358b0850c82b65f2568f872958f2e2a38375b87cc1cfd265",
    "run3.jsonl": "059cc2e8a469980178b6ffe0d49338aef7f5008e156fd3ce999df97ca3daf00b",
    "run4.jsonl": "76ad44f21cfad2a9927987bc43fbe7778d665ea76dcf12a0d68b8033241e68e8",
  };

  it.each(Object.entries(pinned))("%s is unchanged and is a complete JSONL run", (name, sha256) => {
    const bytes = readFileSync(fixture(`prime-jsonl/${name}`));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    const events = bytes
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { type: string });
    expect(events[0]?.type).toBe("session");
    expect(events.at(-1)?.type).toBe("agent_end");
  });
});
