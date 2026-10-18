import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrimeCliError } from "../src/errors.js";
import { buildPrimeChildEnv, createEphemeralPrimeAgentDir, seedPrimeAgentDir } from "../src/server/runtime-config.js";
import * as models from "../src/server/models.js";
import type { PrimeAgentDirPlan } from "../src/types.js";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, runChildProcess: vi.fn(actual.runChildProcess) };
});
vi.mock("../src/server/runtime-config.js", () => ({ resolvePrimeRuntimeConfig: vi.fn(), seedPrimeAgentDir: vi.fn(), createEphemeralPrimeAgentDir: vi.fn(), buildPrimeChildEnv: vi.fn() }));

const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const fixture = (name: string) => readFileSync(fixturePath(name), "utf8");
const scratch: string[] = [];
async function makeScratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wp4-models-"));
  scratch.push(dir);
  return dir;
}
/** Writes an executable /bin/sh script `<dir>/<name>` and returns its absolute path. */
async function fakeCommand(dir: string, name: string, body: string): Promise<string> {
  await fs.writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path.join(dir, name);
}
afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(scratch.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("model list parsing (INTERFACES §8)", () => {
  it("parses the host-auth table into 275 rows in output order", () => {
    const rows = models.parsePrimeModelList(fixture("model-list.txt"));
    expect(rows).toHaveLength(275);
    expect(rows[0]).toEqual({ provider: "anthropic", model: "claude-fable-5", id: "anthropic/claude-fable-5", context: "1M", maxOut: "128K", thinking: true, images: true });
    expect(rows.at(-1)).toEqual({ provider: "vercel-ai-gateway", model: "zai/glm-5v-turbo", id: "vercel-ai-gateway/zai/glm-5v-turbo", context: "200K", maxOut: "128K", thinking: true, images: true });
    expect(rows.find((row) => row.id === "vercel-ai-gateway/zai/glm-5.3")).toMatchObject({ thinking: true, images: false });
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.provider] = (counts[row.provider] ?? 0) + 1;
    expect(counts).toEqual({ anthropic: 16, "openai-codex": 17, "vercel-ai-gateway": 242 });
  });
  it("handles the narrower api-key table and the no-models message", () => {
    const rows = models.parsePrimeModelList(fixture("model-list-api-key-anthropic.txt"));
    expect(rows).toHaveLength(16);
    expect(rows.every((row) => row.provider === "anthropic")).toBe(true);
    expect(rows[2]?.id).toBe("anthropic/claude-haiku-4-5");
    expect(models.parsePrimeModelList(fixture("model-list-no-auth.txt"))).toEqual([]);
    expect(models.parsePrimeModelList("")).toEqual([]);
  });
});


describe("model list command (INTERFACES §8)", () => {
  async function setup(body: string) {
    const dir = await makeScratch();
    const agentDir = path.join(dir, "agent");
    await fs.mkdir(agentDir);
    const command = await fakeCommand(dir, "prime-agent-fake", body);
    return { dir, agentDir, command, env: { PATH: "/usr/bin:/bin", PRIME_AGENT_CODING_AGENT_DIR: agentDir } };
  }
  it("runs `<command> model list` in the given env and returns sorted, deduplicated provider/model ids", async () => {
    const { dir, agentDir, command, env } = await setup(
      `[ "$1 $2" = "model list" ] || exit 9\n[ "$PRIME_AGENT_CODING_AGENT_DIR" = "$EXPECT_AGENT_DIR" ] || exit 8\ncat "${fixturePath("model-list.txt")}" "${fixturePath("model-list-api-key-anthropic.txt")}"`,
    );
    const result = await models.listPrimeModels({ command, env: { ...env, EXPECT_AGENT_DIR: agentDir }, cwd: dir });
    expect(result).toHaveLength(275);
    expect(result.slice(0, 3).map((m) => m.id)).toEqual(["anthropic/claude-fable-5", "anthropic/claude-fable-5-1", "anthropic/claude-haiku-4-5"]);
    expect(result.at(-1)).toEqual({ id: "vercel-ai-gateway/zai/glm-5v-turbo", label: "vercel-ai-gateway/zai/glm-5v-turbo" });
    expect(runChildProcess).toHaveBeenCalledWith(expect.stringMatching(/^prime-models-/), command, ["model", "list"], expect.objectContaining({ cwd: dir, timeoutSec: 20, graceSec: 3 }));
  });
  it("returns [] for the no-models message (exit 0)", async () => {
    const { dir, command, env } = await setup(`cat "${fixturePath("model-list-no-auth.txt")}"`);
    await expect(models.listPrimeModels({ command, env, cwd: dir })).resolves.toEqual([]);
  });
  it("throws prime_model_list_failed with the first output line on a non-zero exit", async () => {
    const { dir, command, env } = await setup('echo "" >&2\necho "auth store locked" >&2\nexit 3');
    const error = await models.listPrimeModels({ command, env, cwd: dir }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PrimeCliError);
    expect(error).toMatchObject({ code: "prime_model_list_failed", message: `\`${command} model list\` failed (exit 3): auth store locked` });
  });
  it("throws prime_model_list_failed on a timeout", async () => {
    const { dir, command, env } = await setup("exit 0");
    vi.mocked(runChildProcess).mockResolvedValueOnce({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "", pid: 1, startedAt: "2026-10-18T00:00:00.000Z" });
    await expect(models.listPrimeModels({ command, env, cwd: dir })).rejects.toMatchObject({ code: "prime_model_list_failed", message: `\`${command} model list\` timed out after 20 s.` });
  });
  it("throws prime_cli_missing when the command cannot be spawned", async () => {
    const { dir, env } = await setup("exit 0");
    const command = path.join(dir, "no-such-prime-agent");
    const error = await models.listPrimeModels({ command, env, cwd: dir }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PrimeCliError);
    expect(error).toMatchObject({ code: "prime_cli_missing", cause: expect.any(Error) });
    expect((error as Error).message).toContain(`Cannot run \`${command}\`: Failed to start command`);
  });
  it("removes keys the caller set to undefined even when the server env has them (INTERFACES §16 A8)", async () => {
    const { dir, command, env } = await setup(`[ -z "\${PRIME_AGENT_INTERNAL_X+x}" ] || exit 7\n[ -z "\${PI_CODING_AGENT_DIR+x}" ] || exit 6\ncat "${fixturePath("model-list-api-key-anthropic.txt")}"`);
    vi.stubEnv("PRIME_AGENT_INTERNAL_X", "1");
    vi.stubEnv("PI_CODING_AGENT_DIR", "/x");
    const childEnv = { ...env, PRIME_AGENT_INTERNAL_X: undefined, PI_CODING_AGENT_DIR: undefined };
    await expect(models.listPrimeModels({ command, env: childEnv, cwd: dir })).resolves.toHaveLength(16);
  });
  it("refuses to run without an absolute PRIME_AGENT_CODING_AGENT_DIR and spawns nothing", async () => {
    const { dir, command } = await setup('touch "$MARKER"');
    for (const agentDir of [undefined, "", "relative/agent"]) {
      const env: Record<string, string> = { PATH: "/usr/bin:/bin", MARKER: path.join(dir, "spawned") };
      if (agentDir !== undefined) env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
      await expect(models.listPrimeModels({ command, env, cwd: dir })).rejects.toMatchObject({ code: "prime_model_list_failed" });
    }
    expect(runChildProcess).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(dir, "spawned"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});


describe("model list cache (INTERFACES §8)", () => {
  it("reuses a result for 60 s per command, cwd, agent dir and env", async () => {
    models.resetPrimeModelsCacheForTests();
    const dir = await makeScratch();
    const counter = path.join(dir, "count");
    const command = await fakeCommand(dir, "prime-agent-fake", `echo run >> "${counter}"\ncat "${fixturePath("model-list-api-key-anthropic.txt")}"`);
    const env = { PATH: "/usr/bin:/bin", PRIME_AGENT_CODING_AGENT_DIR: path.join(dir, "agent-a") };
    const runs = async () => (await fs.readFile(counter, "utf8")).split("\n").filter(Boolean).length;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const first = await models.listPrimeModels({ command, env, cwd: dir });
    expect(first).toHaveLength(16);
    expect(await models.listPrimeModels({ command, env, cwd: dir })).toBe(first);
    expect(await runs()).toBe(1);
    await models.listPrimeModels({ command, env: { ...env, PRIME_AGENT_CODING_AGENT_DIR: path.join(dir, "agent-b") }, cwd: dir });
    expect(await runs()).toBe(2);
    await models.listPrimeModels({ command, env: { ...env, ANTHROPIC_API_KEY: "fake-key" }, cwd: dir });
    expect(await runs()).toBe(3);
    await models.listPrimeModels({ command, env: { ...env, PAPERCLIP_RUN_ID: "run-1" }, cwd: dir });
    expect(await runs()).toBe(3);
    await models.listPrimeModels({ command, env: { ...env, PI_CODING_AGENT_DIR: undefined }, cwd: dir });
    expect(await runs()).toBe(4);
    await models.listPrimeModels({ command, env: { ...env, PI_CODING_AGENT_DIR: undefined }, cwd: dir });
    expect(await runs()).toBe(4);
    now.mockReturnValue(1_000_000 + 60_000);
    await models.listPrimeModels({ command, env, cwd: dir });
    expect(await runs()).toBe(5);
    models.resetPrimeModelsCacheForTests();
    await models.listPrimeModels({ command, env, cwd: dir });
    expect(await runs()).toBe(6);
  });
});


describe("model check (INTERFACES §8)", () => {
  it("accepts a listed id and refuses anything else with up to 12 sample ids", () => {
    const listed = Array.from({ length: 13 }, (_, i) => ({ id: `anthropic/m-${i}`, label: `anthropic/m-${i}` }));
    expect(() => models.assertPrimeModelListed("anthropic/m-12", listed)).not.toThrow();
    const sample = listed.slice(0, 12).map((m) => m.id).join(", ");
    expect(() => models.assertPrimeModelListed("anthropic/claude-nope", listed)).toThrow(
      new PrimeCliError("prime_model_unknown", `Configured Prime model is not listed: anthropic/claude-nope. Listed models: ${sample}, ...`),
    );
    expect(() => models.assertPrimeModelListed("anthropic/m-0", [])).toThrow("Configured Prime model is not listed: anthropic/m-0. Listed models: (none)");
    try {
      models.assertPrimeModelListed("m-0", listed);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PrimeCliError);
      expect(err).toMatchObject({ code: "prime_model_unknown" });
    }
  });
});


describe("adapter model listing (INTERFACES §8)", () => {
  let home: string;
  let plans: PrimeAgentDirPlan[];
  let cleanups: number;
  beforeEach(async () => {
    const dir = await makeScratch();
    home = path.join(dir, "home");
    vi.stubEnv("HOME", home);
    await fakeCommand(dir, "prime-agent", `cat "${fixturePath("model-list.txt")}"`);
    plans = [];
    cleanups = 0;
    vi.mocked(createEphemeralPrimeAgentDir).mockImplementation(async (credential) => {
      const agentDir = await fs.mkdtemp(path.join(dir, "ephemeral-"));
      plans.push({ kind: "ephemeral", agentDir, sessionDir: path.join(agentDir, "sessions"), credential });
      return { plan: plans.at(-1)!, cleanup: async () => void (cleanups += 1) };
    });
    vi.mocked(seedPrimeAgentDir).mockImplementation(async (plan) => ({ plan, auth: "host_auth_symlink", billingType: "unknown", notes: [] }));
    vi.mocked(buildPrimeChildEnv).mockImplementation((_base, plan) => ({ env: { PATH: `${dir}:/usr/bin:/bin`, PRIME_AGENT_CODING_AGENT_DIR: plan.agentDir }, droppedKeys: [] }));
  });
  afterEach(() => models.resetPrimeModelsCacheForTests());
  it("lists the host credential's models through a seeded ephemeral dir and cleans it up", async () => {
    expect(await models.listPrimeModelsForAdapter()).toHaveLength(275);
    expect(createEphemeralPrimeAgentDir).toHaveBeenCalledWith({ mode: "host_auth", hostAuthFile: path.join(home, ".prime", "agent", "auth.json") });
    expect(seedPrimeAgentDir).toHaveBeenCalledWith(plans[0], { provider: "", env: {} });
    expect(buildPrimeChildEnv).toHaveBeenCalledWith(process.env, plans[0], {});
    expect(runChildProcess).toHaveBeenCalledWith(expect.any(String), "prime-agent", ["model", "list"], expect.objectContaining({ cwd: plans[0]?.agentDir }));
    expect(cleanups).toBe(1);
  });
  it("serves list from a 60 s cache while refresh always runs model list again", async () => {
    const first = await models.listPrimeModelsForAdapter();
    expect(await models.listPrimeModelsForAdapter()).toBe(first);
    expect(createEphemeralPrimeAgentDir).toHaveBeenCalledTimes(1);
    expect(await models.refreshPrimeModelsForAdapter()).toHaveLength(275);
    expect(createEphemeralPrimeAgentDir).toHaveBeenCalledTimes(2);
    expect(cleanups).toBe(2);
  });
  it("returns [] on any failure and still cleans up", async () => {
    vi.mocked(seedPrimeAgentDir).mockRejectedValueOnce(new Error("prime_host_auth_missing"));
    await expect(models.listPrimeModelsForAdapter()).resolves.toEqual([]);
    expect(cleanups).toBe(1);
    vi.mocked(createEphemeralPrimeAgentDir).mockRejectedValueOnce(new Error("mkdtemp failed"));
    await expect(models.refreshPrimeModelsForAdapter()).resolves.toEqual([]);
    expect(runChildProcess).not.toHaveBeenCalled();
  });
});


describe("model detection (INTERFACES §8)", () => {
  async function agentDirWith(settings: string | null): Promise<string> {
    const dir = await makeScratch();
    if (settings !== null) await fs.writeFile(path.join(dir, "settings.json"), settings);
    return dir;
  }
  it("returns provider, provider/model and the settings path when both defaults are set", async () => {
    const dir = await agentDirWith('{"defaultProvider":"anthropic","defaultModel":"claude-haiku-4-5","theme":"dark"}');
    await expect(models.detectPrimeModel(dir)).resolves.toEqual({ provider: "anthropic", model: "anthropic/claude-haiku-4-5", source: path.join(dir, "settings.json") });
  });
  it("returns null for a missing file, bad JSON, null or empty defaults", async () => {
    const cases = [null, "{oops", "[]", '{"defaultProvider":null,"defaultModel":null}', '{"defaultProvider":"anthropic","defaultModel":""}', '{"defaultProvider":"","defaultModel":"m"}', '{"defaultProvider":"anthropic","defaultModel":7}'];
    for (const settings of cases) await expect(models.detectPrimeModel(await agentDirWith(settings))).resolves.toBeNull();
  });
  it("detectPrimeModelForAdapter reads <home>/.prime/agent/settings.json and reports a ~ source", async () => {
    const home = await makeScratch();
    vi.stubEnv("HOME", home);
    await expect(models.detectPrimeModelForAdapter()).resolves.toBeNull();
    await fs.mkdir(path.join(home, ".prime", "agent"), { recursive: true });
    await fs.writeFile(path.join(home, ".prime", "agent", "settings.json"), '{"defaultProvider":"openai-codex","defaultModel":"gpt-6.1-sol"}');
    await expect(models.detectPrimeModelForAdapter()).resolves.toEqual({ provider: "openai-codex", model: "openai-codex/gpt-6.1-sol", source: "~/.prime/agent/settings.json" });
  });
});

describe("host default model directory (code review 1)", () => {
  it("refuses the host default agent dir and never invokes the fake CLI", async () => {
    const dir = await makeScratch();
    const home = path.join(dir, "home");
    vi.stubEnv("HOME", home);
    const hostAgentDir = path.join(home, ".prime", "agent");
    await fs.mkdir(hostAgentDir, { recursive: true });
    const marker = path.join(dir, "spawned");
    const command = await fakeCommand(dir, "prime-agent-fake", `touch "${marker}"`);
    for (const agentDir of [hostAgentDir, `${hostAgentDir}/../agent/`, "~/.prime/agent"]) {
      const env = { PATH: "/usr/bin:/bin", PRIME_AGENT_CODING_AGENT_DIR: agentDir };
      await expect(models.listPrimeModels({ command, env, cwd: dir })).rejects.toMatchObject({
        code: "prime_model_list_failed",
        message: expect.stringContaining(hostAgentDir),
      });
    }
    expect(runChildProcess).not.toHaveBeenCalled();
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
