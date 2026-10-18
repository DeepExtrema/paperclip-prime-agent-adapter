import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPrimeSkills, stagePrimeSkills, syncPrimeSkills } from "../src/server/skills.js";

let base: string;
let sources: string;
let tmp: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "wp4-skills-"));
  sources = path.join(base, "sources");
  tmp = path.join(base, "tmp");
  await fs.mkdir(tmp);
  for (const name of ["paperclip", "lint"]) {
    await fs.mkdir(path.join(sources, name), { recursive: true });
    await fs.writeFile(path.join(sources, name, "SKILL.md"), `# ${name}\n`);
  }
  vi.stubEnv("TMPDIR", tmp);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(base, { recursive: true, force: true });
});
function skillConfig(desiredSkills: string[], extra: Array<Record<string, unknown>> = []): Record<string, unknown> {
  return {
    paperclipRuntimeSkills: [
      { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: path.join(sources, "paperclip") },
      { key: "acme/tools/lint", runtimeName: "lint", source: path.join(sources, "lint") },
      { key: "acme/tools/format", runtimeName: "format", source: path.join(sources, "format") },
      { key: "acme/tools/gone", runtimeName: "gone", source: path.join(sources, "gone"), sourceStatus: "missing" },
      ...extra,
    ],
    paperclipSkillSync: { desiredSkills },
  };
}
const ctx = (config: Record<string, unknown>): AdapterSkillContext => ({ agentId: "agent-1", companyId: "company-1", adapterType: "prime_agent_local", config });

describe("skill snapshot (INTERFACES §9)", () => {
  it("reports desired skills as configured (never installed) in ephemeral mode", async () => {
    const snapshot = await listPrimeSkills(ctx(skillConfig(["lint", "gone", "acme/tools/absent"])));
    expect(snapshot).toMatchObject({
      adapterType: "prime_agent_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip", "acme/tools/lint", "acme/tools/gone", "acme/tools/absent"],
      warnings: ['Desired skill "acme/tools/absent" is not available from the Paperclip skills directory.'],
    });
    const byKey = Object.fromEntries(snapshot.entries.map((entry) => [entry.key, entry]));
    expect(byKey["acme/tools/lint"]).toMatchObject({ state: "configured", desired: true, sourcePath: path.join(sources, "lint"), targetPath: null, detail: "Passed to Prime with --skill on the next run." });
    expect(byKey["paperclipai/paperclip/paperclip"]).toMatchObject({ state: "configured", desired: true });
    expect(byKey["acme/tools/format"]).toMatchObject({ state: "available", desired: false, detail: null });
    expect(byKey["acme/tools/gone"]).toMatchObject({ state: "missing", desired: true });
    expect(byKey["acme/tools/absent"]).toMatchObject({ state: "missing", desired: true, runtimeName: null });
    expect(snapshot.entries.some((entry) => entry.state === "installed")).toBe(false);
  });
  it("syncPrimeSkills ignores its desired argument, writes nothing and returns the list snapshot", async () => {
    const config = skillConfig(["lint"]);
    const before = await fs.readdir(base, { recursive: true });
    const synced = await syncPrimeSkills(ctx(config), ["acme/tools/format"]);
    expect(synced).toEqual(await listPrimeSkills(ctx(config)));
    expect(await fs.readdir(base, { recursive: true })).toEqual(before);
  });
});
