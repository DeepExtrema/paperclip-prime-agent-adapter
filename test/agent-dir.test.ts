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
