import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEphemeralPrimeAgentDir, seedPrimeAgentDir } from "../src/server/runtime-config.js";
import type { PrimeAgentDirPlan, PrimeCredentialConfig } from "../src/types.js";
// L1: HOME, TMPDIR and the Paperclip instance root point into a fresh temp root for every test.
let root = "";
let home = "";
let hostAuthFile = "";
async function writeHostAuth(content: unknown, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(hostAuthFile), { recursive: true });
  await fs.writeFile(hostAuthFile, typeof content === "string" ? content : JSON.stringify(content));
  await fs.chmod(hostAuthFile, mode);
}
function agentPlan(
  credential: PrimeCredentialConfig = { mode: "host_auth", hostAuthFile },
  agentDir = path.join(root, "paperclip/instances/default/companies/company-1/agents/agent-1/prime-agent-home"),
): PrimeAgentDirPlan {
  return { kind: "agent", agentDir, sessionDir: path.join(agentDir, "sessions"), credential };
}
async function seedErrorCode(plan: PrimeAgentDirPlan, env: Record<string, string> = {}, provider = "anthropic"): Promise<string> {
  try {
    await seedPrimeAgentDir(plan, { provider, env });
  } catch (err) {
    return (err as { code?: string }).code ?? `no code: ${String(err)}`;
  }
  return "no error";
}
const modeOf = async (target: string): Promise<number> => (await fs.lstat(target)).mode & 0o777;
const exists = async (target: string): Promise<boolean> => (await fs.lstat(target).catch(() => null)) !== null;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prime-wp1-")));
  home = path.join(root, "home");
  await fs.mkdir(path.join(root, "tmp"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("TMPDIR", path.join(root, "tmp"));
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  const roots = [os.homedir(), os.tmpdir(), resolvePaperclipInstanceRootForAdapter()];
  expect(roots).toEqual([home, path.join(root, "tmp"), path.join(root, "paperclip/instances/default")]);
  hostAuthFile = path.join(home, ".prime", "agent", "auth.json");
  await writeHostAuth({ anthropic: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 0 } });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("createEphemeralPrimeAgentDir (INTERFACES §3)", () => {
  it("creates a 0700 temp dir with sessions/ and removes it on cleanup", async () => {
    const credential: PrimeCredentialConfig = { mode: "host_auth", hostAuthFile };
    const { plan, cleanup } = await createEphemeralPrimeAgentDir(credential);
    expect(path.dirname(plan.agentDir)).toBe(os.tmpdir());
    expect(path.basename(plan.agentDir).startsWith("paperclip-prime-agent-")).toBe(true);
    expect(plan).toEqual({ kind: "ephemeral", agentDir: plan.agentDir, sessionDir: path.join(plan.agentDir, "sessions"), credential });
    expect([await modeOf(plan.agentDir), await modeOf(plan.sessionDir)]).toEqual([0o700, 0o700]);
    expect(await fs.readdir(plan.agentDir)).toEqual(["sessions"]);
    await cleanup();
    expect(await exists(plan.agentDir)).toBe(false);
    await expect(cleanup()).resolves.toBeUndefined();
  });
});

describe("seedPrimeAgentDir host_auth link (INTERFACES §3 steps 1-2)", () => {
  it("creates the agent dir and sessions/ with mode 0700, re-asserting it on an existing dir", async () => {
    const plan = agentPlan();
    await fs.mkdir(plan.agentDir, { recursive: true, mode: 0o755 });
    await fs.chmod(plan.agentDir, 0o755);
    await seedPrimeAgentDir(plan, { provider: "anthropic", env: {} });
    expect([await modeOf(plan.agentDir), await modeOf(plan.sessionDir)]).toEqual([0o700, 0o700]);
  });
  it.each([["no file"], ["a regular file"], ["a link to another file"], ["a dangling link"]])(
    "makes auth.json an absolute symlink to the host file when it was %s",
    async (previous) => {
      const plan = agentPlan();
      const authFile = path.join(plan.agentDir, "auth.json");
      await fs.mkdir(plan.agentDir, { recursive: true });
      await fs.writeFile(path.join(root, "other.json"), "{}");
      if (previous === "a regular file") await fs.writeFile(authFile, "{\"stale\":true}");
      if (previous === "a link to another file") await fs.symlink(path.join(root, "other.json"), authFile);
      if (previous === "a dangling link") await fs.symlink(path.join(root, "missing.json"), authFile);
      const seeded = await seedPrimeAgentDir(plan, { provider: "anthropic", env: {} });
      expect([seeded.auth, seeded.plan]).toEqual(["host_auth_symlink", plan]);
      expect([(await fs.lstat(authFile)).isSymbolicLink(), await fs.readlink(authFile)]).toEqual([true, hostAuthFile]);
      expect((await fs.readdir(plan.agentDir)).sort()).toEqual(["auth.json", "sessions"]);
      expect(seeded.notes).toEqual([`Prime agent dir: ${plan.agentDir} (agent).`, `auth.json -> ${hostAuthFile} (host Prime credential).`]);
    },
  );
  it("seeds an ephemeral dir the same way", async () => {
    const { plan, cleanup } = await createEphemeralPrimeAgentDir({ mode: "host_auth", hostAuthFile });
    const seeded = await seedPrimeAgentDir(plan, { provider: "", env: {} });
    expect(await fs.readlink(path.join(plan.agentDir, "auth.json"))).toBe(hostAuthFile);
    expect(seeded.notes[0]).toBe(`Prime agent dir: ${plan.agentDir} (ephemeral).`);
    await cleanup();
  });
});

describe("seedPrimeAgentDir host_auth billing (INTERFACES §3 step 2)", () => {
  it.each([
    ["an oauth entry", { anthropic: { type: "oauth", refresh: "secret-value" } }, "anthropic", "subscription"],
    ["an api_key entry", { anthropic: { type: "api_key", key: "secret-value" } }, "anthropic", "api"],
    ["another type", { anthropic: { type: "bearer", token: "secret-value" } }, "anthropic", "unknown"],
    ["no entry for the provider", { "openai-codex": { type: "oauth", refresh: "secret-value" } }, "anthropic", "unknown"],
    ["an empty provider", { anthropic: { type: "oauth", refresh: "secret-value" } }, "", "unknown"],
    ["invalid JSON", "secret-value {", "anthropic", "unknown"],
  ])("classifies %s", async (_name, content, provider, billingType) => {
    await writeHostAuth(content);
    const seeded = await seedPrimeAgentDir(agentPlan(), { provider, env: {} });
    expect(seeded.billingType).toBe(billingType);
    expect(JSON.stringify(seeded)).not.toContain("secret-value");
  });
});

describe("seedPrimeAgentDir host_auth refusals (INTERFACES §3 step 2)", () => {
  it("refuses a missing host auth file and leaves auth.json absent", async () => {
    await fs.rm(hostAuthFile);
    expect(await seedErrorCode(agentPlan())).toBe("prime_host_auth_missing");
    expect(await exists(path.join(agentPlan().agentDir, "auth.json"))).toBe(false);
  });
  it("refuses a host auth path that is a dangling link", async () => {
    const link = path.join(root, "host-link.json");
    await fs.symlink(path.join(root, "missing.json"), link);
    expect(await seedErrorCode(agentPlan({ mode: "host_auth", hostAuthFile: link }))).toBe("prime_host_auth_missing");
  });
  it("refuses a host auth file readable by group or others", async () => {
    await fs.chmod(hostAuthFile, 0o644);
    expect(await seedErrorCode(agentPlan())).toBe("prime_host_auth_unsafe");
  });
  it("refuses a host auth path that is a directory", async () => {
    await fs.mkdir(path.join(root, "auth-dir"), { mode: 0o700 });
    expect(await seedErrorCode(agentPlan({ mode: "host_auth", hostAuthFile: path.join(root, "auth-dir") }))).toBe("prime_host_auth_unsafe");
  });
});

const API_KEY_CREDENTIAL: PrimeCredentialConfig = { mode: "api_key", provider: "anthropic", apiKeyEnvVar: "ANTHROPIC_API_KEY" };

describe("seedPrimeAgentDir api_key (INTERFACES §3 step 3)", () => {
  it("writes a 0600 auth.json with the trimmed key over a host-mode symlink", async () => {
    const plan = agentPlan(API_KEY_CREDENTIAL);
    const authFile = path.join(plan.agentDir, "auth.json");
    await fs.mkdir(plan.agentDir, { recursive: true });
    await fs.symlink(hostAuthFile, authFile);
    const hostBefore = await fs.readFile(hostAuthFile, "utf8");
    const seeded = await seedPrimeAgentDir(plan, { provider: "anthropic", env: { ANTHROPIC_API_KEY: "  sk-ant-fixture  " } });
    const stat = await fs.lstat(authFile);
    expect([stat.isFile(), stat.mode & 0o777]).toEqual([true, 0o600]);
    expect(JSON.parse(await fs.readFile(authFile, "utf8"))).toEqual({ anthropic: { type: "api_key", key: "sk-ant-fixture" } });
    expect(await fs.readFile(hostAuthFile, "utf8")).toBe(hostBefore);
    expect(seeded).toMatchObject({ auth: "api_key_file", billingType: "api" });
    expect(seeded.notes).toEqual([`Prime agent dir: ${plan.agentDir} (agent).`, "auth.json written from ANTHROPIC_API_KEY for provider anthropic."]);
    expect(JSON.stringify(seeded)).not.toContain("sk-ant-fixture");
    expect((await fs.readdir(plan.agentDir)).sort()).toEqual(["auth.json", "sessions"]);
  });
  it.each<[string, Record<string, string>]>([["unset", {}], ["blank", { ANTHROPIC_API_KEY: "   " }]])(
    "refuses a key variable that is %s",
    async (_name, env) => {
      expect(await seedErrorCode(agentPlan(API_KEY_CREDENTIAL), env)).toBe("prime_api_key_missing");
      expect(await exists(path.join(agentPlan().agentDir, "auth.json"))).toBe(false);
    },
  );
});

describe("seedPrimeAgentDir agent dir safety (INTERFACES §3 step 1, L6)", () => {
  it("refuses an agent dir that is a symlink and writes nothing through it", async () => {
    await fs.mkdir(path.join(root, "elsewhere"));
    await fs.symlink(path.join(root, "elsewhere"), path.join(root, "linked-home"));
    expect(await seedErrorCode(agentPlan(undefined, path.join(root, "linked-home")))).toBe("prime_agent_dir_unsafe");
    expect(await fs.readdir(path.join(root, "elsewhere"))).toEqual([]);
  });
  it.each([[".prime/agent"], [".pi"], [".codex"], [".claude"], [".ssh"], [".gnupg"], [".aws"], [".config"]])(
    "refuses an agent dir inside ~/%s and creates nothing",
    async (entry) => {
      expect(await seedErrorCode(agentPlan(undefined, path.join(home, entry, "agent-1", "home")))).toBe("prime_agent_dir_unsafe");
      expect(await exists(path.join(home, entry, "agent-1"))).toBe(false);
    },
  );
  it.each([["secrets"], ["db"], ["data/backups"], ["logs"]])("refuses an agent dir inside the instance %s dir", async (entry) => {
    const agentDir = path.join(root, "paperclip/instances/default", entry, "agent-1");
    expect(await seedErrorCode(agentPlan(undefined, agentDir))).toBe("prime_agent_dir_unsafe");
  });
  it("refuses an agent dir that contains a protected path", async () => {
    expect(await seedErrorCode(agentPlan(undefined, home))).toBe("prime_agent_dir_unsafe");
  });
  it("refuses an agent dir whose real path is inside a protected path", async () => {
    await fs.symlink(path.join(home, ".prime"), path.join(root, "agents-link"));
    expect(await seedErrorCode(agentPlan(undefined, path.join(root, "agents-link", "agent-1", "home")))).toBe("prime_agent_dir_unsafe");
    expect(await fs.readdir(path.join(home, ".prime"))).toEqual(["agent"]);
  });
  it("refuses an auth.json that is a directory", async () => {
    await fs.mkdir(path.join(agentPlan().agentDir, "auth.json"), { recursive: true });
    expect(await seedErrorCode(agentPlan())).toBe("prime_agent_dir_unsafe");
  });
});
