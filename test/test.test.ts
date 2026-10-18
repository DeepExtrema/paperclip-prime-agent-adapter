import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrimeCliError, PrimeConfigError, PrimeCredentialError } from "../src/errors.js";
import { testEnvironment } from "../src/server/test.js";
import type { PrimeAgentDirPlan, PrimeCredentialConfig, PrimeRuntimeConfig } from "../src/types.js";

// WP1 (runtime-config) and WP4 (models) are stubs on this branch: test doubles stand in for
// their frozen contracts (INTERFACES.md §2-§4, §8, §16 A8-A9, A16). version.ts is real and runs a fake CLI script.
const mocks = vi.hoisted(() => ({
  resolvePrimeRuntimeConfig: vi.fn(), seedPrimeAgentDir: vi.fn(), createEphemeralPrimeAgentDir: vi.fn(), buildPrimeChildEnv: vi.fn(),
  assertPrimeCwdAllowed: vi.fn(), listPrimeModels: vi.fn(), assertPrimeModelListed: vi.fn(),
}));
vi.mock("../src/server/runtime-config.js", () => ({ ...mocks }));
vi.mock("../src/server/models.js", () => ({ ...mocks }));

const MODEL_REF = "anthropic/claude-haiku-4-5";
let root: string;
let workDir: string;
let ephemeralDirs: string[];
let cleanups: Array<ReturnType<typeof vi.fn>>;

function runtime(overrides: Partial<PrimeRuntimeConfig> = {}): PrimeRuntimeConfig {
  const credential: PrimeCredentialConfig = { mode: "host_auth", hostAuthFile: path.join(root, "host-auth.json") };
  const agentDir = path.join(root, "agents", "agent-1", "prime-agent-home");
  return {
    command: path.join(root, "bin", "prime-agent"), modelRef: MODEL_REF, provider: "anthropic", model: "claude-haiku-4-5",
    thinking: null, cwd: workDir, instructionsFilePath: null, promptTemplate: null, bootstrapPromptTemplate: null,
    appendSystemPrompt: null, noContextFiles: false, timeoutSec: 0, graceSec: 20, extraArgs: [], env: {}, credential,
    agentDir: { kind: "agent", agentDir, sessionDir: path.join(agentDir, "sessions"), credential },
    ...overrides,
  };
}

async function writeFakePrime(versionLine: string): Promise<string> {
  const file = path.join(root, "bin", "prime-agent");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${versionLine}"; exit 0; fi\nexit 2\n`);
  await chmod(file, 0o755);
  return file;
}

function ctx(overrides: Partial<AdapterEnvironmentTestContext> = {}): AdapterEnvironmentTestContext {
  return { companyId: "company-1", adapterType: "prime_agent_local", config: { model: MODEL_REF }, ...overrides };
}

const codes = (result: AdapterEnvironmentTestResult): string[] => result.checks.map((entry) => entry.code);

function check(result: AdapterEnvironmentTestResult, code: string) {
  const found = result.checks.find((entry) => entry.code === code);
  if (!found) throw new Error(`no check ${code} in ${codes(result).join(",")}`);
  return found;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "wp5-envtest-"));
  workDir = path.join(root, "work");
  await mkdir(workDir);
  ephemeralDirs = [];
  cleanups = [];
  await writeFakePrime("0.10.0");
  mocks.resolvePrimeRuntimeConfig.mockReset().mockImplementation(() => runtime());
  mocks.assertPrimeCwdAllowed.mockReset().mockResolvedValue(undefined);
  mocks.createEphemeralPrimeAgentDir.mockReset().mockImplementation(async (credential: PrimeCredentialConfig) => {
    const agentDir = await mkdtemp(path.join(root, "ephemeral-"));
    ephemeralDirs.push(agentDir);
    const cleanup = vi.fn(async () => rm(agentDir, { recursive: true, force: true }));
    cleanups.push(cleanup);
    const plan: PrimeAgentDirPlan = { kind: "ephemeral", agentDir, sessionDir: path.join(agentDir, "sessions"), credential };
    return { plan, cleanup };
  });
  mocks.buildPrimeChildEnv.mockReset().mockImplementation((_base: NodeJS.ProcessEnv, plan: PrimeAgentDirPlan, extra: Record<string, string>) => ({
    env: { PATH: "/usr/bin:/bin", ...extra, PRIME_AGENT_CODING_AGENT_DIR: plan.agentDir, PRIME_AGENT_TELEMETRY: "0" },
    droppedKeys: [],
  }));
  mocks.seedPrimeAgentDir
    .mockReset()
    .mockImplementation(async (plan: PrimeAgentDirPlan) => ({ plan, auth: "host_auth_symlink", billingType: "subscription", notes: [] }));
  const ids = ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-5-5"];
  mocks.listPrimeModels.mockReset().mockResolvedValue(ids.map((id) => ({ id, label: id })));
  mocks.assertPrimeModelListed.mockReset().mockImplementation((modelRef: string, models: Array<{ id: string }>) => {
    if (!models.some((entry) => entry.id === modelRef)) throw new PrimeCliError("prime_model_unknown", `${modelRef} is not listed`);
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("testEnvironment: execution target (INTERFACES.md §10)", () => {
  it("refuses a remote execution target before any other step", async () => {
    const executionTarget = { kind: "remote", transport: "ssh", remoteCwd: "/srv/work", spec: {} } as never;
    const result = await testEnvironment(ctx({ executionTarget }));
    expect(result).toEqual({
      adapterType: "prime_agent_local",
      status: "fail",
      checks: [{ code: "prime_config_invalid", level: "error", message: "remote execution targets are not supported in phase 1" }],
      testedAt: expect.any(String),
    });
    expect(new Date(result.testedAt).toISOString()).toBe(result.testedAt);
    expect(mocks.resolvePrimeRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.createEphemeralPrimeAgentDir).not.toHaveBeenCalled();
  });

  it("accepts an explicit local execution target", async () => {
    const result = await testEnvironment(ctx({ executionTarget: { kind: "local" } }));
    expect(codes(result)).not.toContain("prime_config_invalid");
    expect(result.adapterType).toBe("prime_agent_local");
  });
});

describe("testEnvironment: config (INTERFACES.md §10)", () => {
  it.each([
    ["prime_model_required", "prime_model_required"], ["prime_model_invalid", "prime_model_invalid"],
    ["prime_thinking_invalid", "prime_thinking_invalid"], ["prime_credential_mode_invalid", "prime_config_invalid"],
    ["prime_api_key_env_var_required", "prime_config_invalid"], ["prime_path_invalid", "prime_config_invalid"],
  ] as const)("maps PrimeConfigError %s to check %s and stops", async (errorCode, checkCode) => {
    mocks.resolvePrimeRuntimeConfig.mockImplementation(() => {
      throw new PrimeConfigError(errorCode, `bad config: ${errorCode}`);
    });
    const result = await testEnvironment(ctx());
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([{ code: checkCode, level: "error", message: `bad config: ${errorCode}` }]);
    expect(mocks.createEphemeralPrimeAgentDir).not.toHaveBeenCalled();
  });

  it("resolves the config with ctx.config, ctx.companyId and the instance root", async () => {
    const config = { model: MODEL_REF, thinking: "low" };
    await testEnvironment(ctx({ config }));
    const agent = { id: "environment-test", companyId: "company-1" };
    expect(mocks.resolvePrimeRuntimeConfig).toHaveBeenCalledWith(config, agent, expect.stringMatching(/instances/));
  });
});

describe("testEnvironment: cwd (INTERFACES.md §10, §16 A16)", () => {
  it("reports a valid configured cwd", async () => {
    const result = await testEnvironment(ctx());
    expect(mocks.assertPrimeCwdAllowed).toHaveBeenCalledWith(workDir);
    expect(check(result, "prime_cwd_valid")).toEqual({ code: "prime_cwd_valid", level: "info", message: `Working directory is valid: ${workDir}` });
  });

  it("uses process.cwd() when no cwd is configured", async () => {
    mocks.resolvePrimeRuntimeConfig.mockImplementation(() => runtime({ cwd: null }));
    const result = await testEnvironment(ctx());
    expect(check(result, "prime_cwd_valid").message).toBe(`Working directory is valid: ${process.cwd()}`);
  });

  it("fails on a missing cwd, never creates it and stops", async () => {
    const missing = path.join(root, "missing");
    mocks.resolvePrimeRuntimeConfig.mockImplementation(() => runtime({ cwd: missing }));
    const result = await testEnvironment(ctx());
    expect(result.status).toBe("fail");
    const message = `Working directory does not exist: "${missing}"`;
    expect(result.checks).toEqual([{ code: "prime_cwd_invalid", level: "error", message, detail: missing }]);
    await expect(stat(missing)).rejects.toThrow(/ENOENT/);
    expect(mocks.createEphemeralPrimeAgentDir).not.toHaveBeenCalled();
  });

  it("fails with prime_cwd_invalid when assertPrimeCwdAllowed refuses the cwd (A16)", async () => {
    mocks.assertPrimeCwdAllowed.mockRejectedValue(new PrimeConfigError("prime_path_invalid", "cwd is a protected path"));
    const result = await testEnvironment(ctx());
    expect(result.checks).toEqual([{ code: "prime_cwd_invalid", level: "error", message: "cwd is a protected path", detail: workDir }]);
    expect(mocks.createEphemeralPrimeAgentDir).not.toHaveBeenCalled();
  });
});

describe("testEnvironment: CLI (INTERFACES.md §10)", () => {
  it("finds the CLI with the child env of a fresh ephemeral dir and cleans the dir up", async () => {
    const result = await testEnvironment(ctx());
    const message = `Prime CLI found: ${path.join(root, "bin", "prime-agent")}`;
    expect(check(result, "prime_cli_found")).toEqual({ code: "prime_cli_found", level: "info", message });
    expect(mocks.createEphemeralPrimeAgentDir).toHaveBeenCalledTimes(1);
    expect(mocks.createEphemeralPrimeAgentDir).toHaveBeenCalledWith(runtime().credential);
    const plan = expect.objectContaining({ kind: "ephemeral", agentDir: ephemeralDirs[0] });
    expect(mocks.buildPrimeChildEnv).toHaveBeenCalledWith(process.env, plan, {});
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    await expect(stat(ephemeralDirs[0]!)).rejects.toThrow(/ENOENT/);
  });

  it("resolves a bare command name through the child env PATH", async () => {
    mocks.resolvePrimeRuntimeConfig.mockImplementation(() => runtime({ command: "prime-agent" }));
    mocks.buildPrimeChildEnv.mockImplementation((_base: NodeJS.ProcessEnv, plan: PrimeAgentDirPlan) => ({
      env: { PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, PRIME_AGENT_CODING_AGENT_DIR: plan.agentDir },
      droppedKeys: [],
    }));
    const result = await testEnvironment(ctx());
    expect(check(result, "prime_cli_found").message).toBe(`Prime CLI found: ${path.join(root, "bin", "prime-agent")}`);
  });

  it("reports prime_cli_missing and skips the version step", async () => {
    const missing = path.join(root, "bin", "no-such-prime-agent");
    mocks.resolvePrimeRuntimeConfig.mockImplementation(() => runtime({ command: missing }));
    const result = await testEnvironment(ctx());
    expect(result.status).toBe("fail");
    const message = `Command is not executable: "${missing}" (resolved: "${missing}")`;
    expect(check(result, "prime_cli_missing")).toEqual({ code: "prime_cli_missing", level: "error", message, detail: missing });
    expect(codes(result).filter((code) => code.startsWith("prime_cli_version"))).toEqual([]);
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
  });

  it("returns a failing check with the PrimeCredentialError code when the ephemeral dir cannot be created", async () => {
    mocks.createEphemeralPrimeAgentDir.mockRejectedValueOnce(new PrimeCredentialError("prime_host_auth_unsafe", "host auth is unsafe"));
    const result = await testEnvironment(ctx());
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([
      { code: "prime_cwd_valid", level: "info", message: `Working directory is valid: ${workDir}` },
      { code: "prime_host_auth_unsafe", level: "error", message: "host auth is unsafe" },
    ]);
  });

  it("uses prime_agent_dir_unsafe for any other ephemeral-dir error", async () => {
    mocks.createEphemeralPrimeAgentDir.mockRejectedValueOnce(new Error("EACCES: mkdtemp failed"));
    const result = await testEnvironment(ctx());
    expect(result.checks.at(-1)).toEqual({ code: "prime_agent_dir_unsafe", level: "error", message: "EACCES: mkdtemp failed" });
  });
});

describe("testEnvironment: version (INTERFACES.md §8, §10)", () => {
  it("reports a supported version", async () => {
    const result = await testEnvironment(ctx());
    expect(check(result, "prime_cli_version")).toEqual({ code: "prime_cli_version", level: "info", message: "prime-agent 0.10.0" });
  });

  it("fails on an unsupported version", async () => {
    await writeFakePrime("0.11.0");
    const result = await testEnvironment(ctx());
    expect(result.status).toBe("fail");
    const message = "prime-agent 0.11.0 is not supported; supported range is >= 0.10.0 and < 0.11.0.";
    expect(check(result, "prime_cli_version_unsupported")).toEqual({ code: "prime_cli_version_unsupported", level: "error", message });
  });

  it("fails on unreadable version output", async () => {
    const command = await writeFakePrime("garbage");
    const result = await testEnvironment(ctx());
    const message = `"${command} --version" printed "garbage", not a x.y.z version.`;
    expect(check(result, "prime_cli_version_unreadable")).toEqual({ code: "prime_cli_version_unreadable", level: "error", message, detail: command });
  });
});

describe("testEnvironment: credential (INTERFACES.md §3, §10)", () => {
  it("seeds the ephemeral dir with the configured credential and reports host auth", async () => {
    const result = await testEnvironment(ctx());
    const plan = expect.objectContaining({ kind: "ephemeral", agentDir: ephemeralDirs[0] });
    expect(mocks.seedPrimeAgentDir).toHaveBeenCalledWith(plan, { provider: "anthropic", env: {} });
    const message = "Host Prime auth file is present and safe (billing: subscription).";
    expect(check(result, "prime_auth_host_linked")).toEqual({ code: "prime_auth_host_linked", level: "info", message });
  });

  it("reports an api_key credential without showing the key", async () => {
    const secret = "sk-wp5-secret-value";
    const credential = { mode: "api_key", provider: "anthropic", apiKeyEnvVar: "ANTHROPIC_API_KEY" } as const;
    mocks.resolvePrimeRuntimeConfig.mockImplementation(() => runtime({ credential, env: { ANTHROPIC_API_KEY: secret } }));
    mocks.seedPrimeAgentDir.mockImplementation(async (plan: PrimeAgentDirPlan) => ({ plan, auth: "api_key_file", billingType: "api", notes: [] }));
    const result = await testEnvironment(ctx());
    expect(mocks.seedPrimeAgentDir).toHaveBeenCalledWith(expect.anything(), { provider: "anthropic", env: { ANTHROPIC_API_KEY: secret } });
    const message = "API key from env var ANTHROPIC_API_KEY is set (value not shown).";
    expect(check(result, "prime_auth_api_key")).toEqual({ code: "prime_auth_api_key", level: "info", message });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    ["prime_host_auth_missing", "prime_auth_missing"], ["prime_api_key_missing", "prime_auth_missing"],
    ["prime_host_auth_unsafe", "prime_auth_unsafe"], ["prime_auth_file_unsafe", "prime_auth_unsafe"],
    ["prime_agent_dir_unsafe", "prime_auth_unsafe"],
  ] as const)("maps PrimeCredentialError %s to check %s", async (errorCode, checkCode) => {
    mocks.seedPrimeAgentDir.mockRejectedValue(new PrimeCredentialError(errorCode, `credential problem: ${errorCode}`));
    const result = await testEnvironment(ctx());
    expect(result.status).toBe("fail");
    expect(check(result, checkCode)).toEqual({ code: checkCode, level: "error", message: `credential problem: ${errorCode}` });
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
  });

  it("still checks the credential when the CLI is missing", async () => {
    mocks.resolvePrimeRuntimeConfig.mockImplementation(() => runtime({ command: path.join(root, "bin", "nope") }));
    const result = await testEnvironment(ctx());
    expect(codes(result)).toEqual(["prime_cwd_valid", "prime_cli_missing", "prime_auth_host_linked"]);
  });
});
