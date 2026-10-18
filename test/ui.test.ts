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

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "prime_agent_local", cwd: "", instructionsFilePath: "", promptTemplate: "", model: "", thinkingEffort: "",
    chrome: false, dangerouslySkipPermissions: false, search: false, fastMode: false, dangerouslyBypassSandbox: false,
    command: "", args: "", extraArgs: "", envVars: "", envBindings: {}, url: "", bootstrapPrompt: "",
    maxTurnsPerRun: 1000, heartbeatEnabled: false, intervalSec: 300, ...overrides,
  };
}

describe("buildPrimeLocalConfig", () => {
  it("writes only the pi-local timeout defaults for an empty form", () => {
    expect(buildPrimeLocalConfig(makeValues())).toEqual({ timeoutSec: 0, graceSec: 20 });
  });
  it("maps the standard form fields and splits argument strings", () => {
    const config = buildPrimeLocalConfig(makeValues({
      cwd: "/srv/work", instructionsFilePath: "/srv/work/AGENTS.md", model: "anthropic/claude-haiku-4-5", thinkingEffort: "low",
      command: "prime-agent", extraArgs: " --no-skills  --verbose ", envVars: "FOO=bar",
    }));
    expect(config).toEqual({
      cwd: "/srv/work", instructionsFilePath: "/srv/work/AGENTS.md", model: "anthropic/claude-haiku-4-5", thinking: "low",
      timeoutSec: 0, graceSec: 20, env: { FOO: { type: "plain", value: "bar" } }, command: "prime-agent",
      extraArgs: ["--no-skills", "--verbose"],
    });
  });
  it("copies credentialMode and a trimmed apiKeyEnvVar from adapterSchemaValues", () => {
    const values = makeValues({ adapterSchemaValues: { credentialMode: "api_key", apiKeyEnvVar: " ANTHROPIC_API_KEY " } });
    expect(buildPrimeLocalConfig(values)).toEqual({ timeoutSec: 0, graceSec: 20, credentialMode: "api_key", apiKeyEnvVar: "ANTHROPIC_API_KEY" });
  });
});
