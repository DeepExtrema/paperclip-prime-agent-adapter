import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PrimeConfigError } from "../src/errors.js";
import { resolvePrimeRuntimeConfig } from "../src/server/runtime-config.js";
import { PRIME_THINKING_LEVELS } from "../src/types.js";
const AGENT = { id: "agent-1", companyId: "company-1" };
const INSTANCE_ROOT = "/srv/paperclip/instances/default";
function configErrorCode(config: Record<string, unknown>, agent = AGENT, instanceRoot = INSTANCE_ROOT): string {
  try {
    resolvePrimeRuntimeConfig(config, agent, instanceRoot);
  } catch (err) {
    return err instanceof PrimeConfigError ? err.code : `not a PrimeConfigError: ${String(err)}`;
  }
  return "no error";
}

describe("resolvePrimeRuntimeConfig mapping (INTERFACES §2)", () => {
  it("applies the defaults and the agent dir layout", () => {
    const credential = { mode: "host_auth", hostAuthFile: path.join(os.homedir(), ".prime", "agent", "auth.json") };
    const agentDir = `${INSTANCE_ROOT}/companies/company-1/agents/agent-1/prime-agent-home`;
    expect(resolvePrimeRuntimeConfig({ model: " anthropic/claude-haiku-4-5 " }, AGENT, INSTANCE_ROOT)).toEqual({
      command: "prime-agent", modelRef: "anthropic/claude-haiku-4-5", provider: "anthropic", model: "claude-haiku-4-5",
      thinking: null, cwd: null, instructionsFilePath: null, promptTemplate: null, bootstrapPromptTemplate: null,
      appendSystemPrompt: null, noContextFiles: false, timeoutSec: 0, graceSec: 20, extraArgs: [], env: {}, credential,
      agentDir: { kind: "agent", agentDir, sessionDir: `${agentDir}/sessions`, credential },
    });
  });
  it("maps every configured key", () => {
    const config = {
      command: " /opt/prime/bin/prime-agent ", model: "vercel-ai-gateway/openai/gpt-6.1-sol", thinking: "high",
      cwd: "/work/repo/", instructionsFilePath: "/work/AGENTS.md", promptTemplate: "  Do {{task}}  ",
      bootstrapPromptTemplate: "Start here.", appendSystemPrompt: "Be brief.", noContextFiles: true, timeoutSec: 600,
      graceSec: 5, extraArgs: ["--verbose", 7], args: ["--ignored"],
      env: { AI_GATEWAY_API_KEY: "gw-key", NUMBER: 2, OBJECT: { type: "secret_ref" } },
      credentialMode: "api_key", apiKeyEnvVar: " AI_GATEWAY_API_KEY ", agentDirRoot: "/data/prime-agents/",
    };
    const credential = { mode: "api_key", provider: "vercel-ai-gateway", apiKeyEnvVar: "AI_GATEWAY_API_KEY" };
    const agentDir = "/data/prime-agents/agent-1/prime-agent-home";
    expect(resolvePrimeRuntimeConfig(config, AGENT, INSTANCE_ROOT)).toEqual({
      command: "/opt/prime/bin/prime-agent", modelRef: "vercel-ai-gateway/openai/gpt-6.1-sol",
      provider: "vercel-ai-gateway", model: "openai/gpt-6.1-sol", thinking: "high", cwd: "/work/repo",
      instructionsFilePath: "/work/AGENTS.md", promptTemplate: "  Do {{task}}  ", bootstrapPromptTemplate: "Start here.",
      appendSystemPrompt: "Be brief.", noContextFiles: true, timeoutSec: 600, graceSec: 5, extraArgs: ["--verbose"],
      env: { AI_GATEWAY_API_KEY: "gw-key" }, credential,
      agentDir: { kind: "agent", agentDir, sessionDir: `${agentDir}/sessions`, credential },
    });
  });
  it("falls back to args and ignores negative or non-number timeouts", () => {
    const config = { model: "a/b", args: ["--a"], timeoutSec: -5, graceSec: "30", noContextFiles: "yes", promptTemplate: " " };
    expect(resolvePrimeRuntimeConfig(config, AGENT, INSTANCE_ROOT)).toMatchObject({
      extraArgs: ["--a"], timeoutSec: 0, graceSec: 20, noContextFiles: false, promptTemplate: null,
    });
  });
});

describe("resolvePrimeRuntimeConfig model (INTERFACES §2)", () => {
  it.each([[undefined], [""], ["   "], [42]])("requires model, refusing %j", (model) => {
    expect(configErrorCode({ model })).toBe("prime_model_required");
  });
  it.each([["claude-haiku-4-5"], ["/claude-haiku-4-5"], ["anthropic/"]])("refuses model %j without provider/modelId", (model) => {
    expect(configErrorCode({ model })).toBe("prime_model_invalid");
  });
});

describe("resolvePrimeRuntimeConfig thinking (INTERFACES §2, §16 A6)", () => {
  it.each([["turbo"], ["HIGH"], [3]])("refuses thinking %j", (thinking) => {
    expect(configErrorCode({ model: "a/b", thinking })).toBe("prime_thinking_invalid");
  });
  it("accepts every PRIME_THINKING_LEVELS value and treats blank as unset", () => {
    for (const thinking of [...PRIME_THINKING_LEVELS, " "]) {
      const resolved = resolvePrimeRuntimeConfig({ model: "a/b", thinking }, AGENT, INSTANCE_ROOT);
      expect(resolved.thinking).toBe(thinking === " " ? null : thinking);
    }
  });
  it("reads thinkingEffort (host UI key) when thinking is unset; empty means Prime default", () => {
    const thinkingOf = (config: Record<string, unknown>) => resolvePrimeRuntimeConfig({ model: "a/b", ...config }, AGENT, INSTANCE_ROOT).thinking;
    expect(thinkingOf({ thinkingEffort: "low" })).toBe("low");
    expect(thinkingOf({ thinking: "", thinkingEffort: "medium" })).toBe("medium");
    expect(thinkingOf({ thinking: "high", thinkingEffort: "low" })).toBe("high");
    expect(thinkingOf({ thinkingEffort: "" })).toBeNull();
    expect(configErrorCode({ model: "a/b", thinkingEffort: "turbo" })).toBe("prime_thinking_invalid");
  });
});
