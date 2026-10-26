import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { checkPrimeSkillList } from "../src/server/skill-list.js";
import { listPrimeSkills, quotePrimeFrontmatter, stagePrimeSkills, syncPrimeSkills } from "../src/server/skills.js";

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


describe("skill staging (INTERFACES §9)", () => {
  it("symlinks each desired, present skill into one temp dir and returns one --skill dir per skill", async () => {
    const staged = await stagePrimeSkills(skillConfig(["lint", "gone", "acme/tools/absent"]));
    const [root] = await fs.readdir(tmp);
    expect(root).toMatch(/^paperclip-prime-skills-/);
    const stagedRoot = path.join(tmp, root!);
    expect(staged.skillDirs).toEqual([path.join(stagedRoot, "paperclip"), path.join(stagedRoot, "lint")]);
    expect(staged.missing).toEqual(["gone", "acme/tools/absent"]);
    expect(await fs.readlink(path.join(stagedRoot, "lint"))).toBe(path.join(sources, "lint"));
    expect(await fs.readFile(path.join(stagedRoot, "lint", "SKILL.md"), "utf8")).toBe("# lint\n");
    expect((await fs.readdir(stagedRoot)).sort()).toEqual(["lint", "paperclip"]);
    await staged.cleanup();
  });
  it("cleanup removes the temp dir, keeps the skill sources and never throws", async () => {
    const staged = await stagePrimeSkills(skillConfig(["lint"]));
    await staged.cleanup();
    await staged.cleanup();
    expect(await fs.readdir(tmp)).toEqual([]);
    expect(await fs.readFile(path.join(sources, "lint", "SKILL.md"), "utf8")).toBe("# lint\n");
  });
  it("reports a runtime name that is not a single path segment as missing and never links it (INTERFACES §16 A10)", async () => {
    const escape = { key: "acme/tools/escape", runtimeName: "../escape", source: path.join(sources, "lint") };
    const staged = await stagePrimeSkills(skillConfig(["acme/tools/escape"], [escape]));
    expect(staged.skillDirs.map((dir) => path.basename(dir))).toEqual(["paperclip"]);
    expect(staged.missing).toEqual(["../escape (unsafe runtime name: not a single path segment)"]);
    await expect(fs.lstat(path.join(tmp, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
    await staged.cleanup();
    expect(await fs.readdir(tmp)).toEqual([]);
  });
  it("stages only the operational skill when nothing else is desired", async () => {
    const staged = await stagePrimeSkills(skillConfig([]));
    expect(staged.skillDirs.map((dir) => path.basename(dir))).toEqual(["paperclip"]);
    expect(staged.missing).toEqual([]);
    await staged.cleanup();
  });
});

describe("failed skill staging (INTERFACES §9, R-27)", () => {
  it("removes the temp dir and rethrows the original symlink error", async () => {
    const duplicate = { key: "acme/other/lint", runtimeName: "lint", source: path.join(sources, "paperclip") };
    const error = await stagePrimeSkills(skillConfig(["acme/tools/lint", "acme/other/lint"], [duplicate])).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "EEXIST", syscall: "symlink" });
    expect(await fs.readdir(tmp)).toEqual([]);
  });
});

describe("G1: skills staged under their frontmatter name (TAI-273 §4.1)", () => {
  async function source(dir: string, name: string | null) {
    await fs.mkdir(path.join(sources, dir), { recursive: true });
    await fs.writeFile(path.join(sources, dir, "SKILL.md"), name === null ? "# no frontmatter\n" : `---\nname: ${name}\ndescription: d\n---\n# body\n`);
    return { key: `company/${dir}`, runtimeName: dir, source: path.join(sources, dir) };
  }
  it("stages a hashed runtime name under its frontmatter name, and keeps the runtime name with one log line otherwise", async () => {
    const extra = [
      await source("simplified-english--9876d8956d", "simplified-english"),
      await source("goal--1111111111", "goal"),
      await source("bad--2222222222", "Bad_Name"),
      await source("dup-a--3333333333", "dup"),
      await source("dup-b--4444444444", '"dup"'),
    ];
    const staged = await stagePrimeSkills(skillConfig(extra.map((entry) => entry.key), extra));
    expect(staged.skillDirs.map((dir) => path.basename(dir))).toEqual([
      "paperclip", "simplified-english", "goal--1111111111", "bad--2222222222", "dup-a--3333333333", "dup-b--4444444444",
    ]);
    expect(await fs.readFile(path.join(staged.skillDirs[1]!, "SKILL.md"), "utf8")).toContain("name: simplified-english");
    expect(staged.logLines).toEqual([
      '[paperclip] Skill "paperclip" is staged under its runtime name: its SKILL.md has no frontmatter name.\n',
      '[paperclip] Skill "goal--1111111111" is staged under its runtime name: "goal" is a Prime built-in skill name.\n',
      '[paperclip] Skill "bad--2222222222" is staged under its runtime name: its frontmatter name "Bad_Name" is not a valid Prime skill name.\n',
      '[paperclip] Skill "dup-a--3333333333" is staged under its runtime name: another skill also has the name "dup".\n',
      '[paperclip] Skill "dup-b--4444444444" is staged under its runtime name: another skill also has the name "dup".\n',
    ]);
    await staged.cleanup();
  });
  it("refuses names longer than 64 characters and names with --", async () => {
    const extra = [await source("long--5555555555", "a".repeat(65)), await source("dash--6666666666", "two--parts")];
    const staged = await stagePrimeSkills(skillConfig(extra.map((entry) => entry.key), extra));
    expect(staged.skillDirs.map((dir) => path.basename(dir)).slice(1)).toEqual(["long--5555555555", "dash--6666666666"]);
    await staged.cleanup();
  });
  it("listSkills reports the staged name next to the runtime name", async () => {
    const extra = [await source("simplified-english--9876d8956d", "simplified-english")];
    const snapshot = await listPrimeSkills(ctx(skillConfig([extra[0]!.key], extra)));
    const entry = snapshot.entries.find((candidate) => candidate.key === extra[0]!.key);
    expect(entry).toMatchObject({ runtimeName: "simplified-english--9876d8956d", locationLabel: "Prime skill name: simplified-english" });
  });
});

describe("TAI-365: frontmatter Prime cannot parse", () => {
  const VEGA = fileURLToPath(new URL("./fixtures/vega-skills", import.meta.url));
  const SUMMARIZE = "Write a short, colloquial summary for a Paperclip summary slot: open with the 1–3 specific, concrete actions the reader needs to take right now to unblock the work, then a brief plain-language status, streaming progress as it works.";
  it("double-quotes a plain value holding \": \", and leaves every other line alone", () => {
    const text = `---\nname: summarize-status\ndescription: ${SUMMARIZE}\nkey: a/b\ntags:\n  - x: y\n---\n# body: here\n`;
    expect(quotePrimeFrontmatter(text)).toEqual({ text: text.replace(SUMMARIZE, JSON.stringify(SUMMARIZE)), keys: ["description"] });
    expect(quotePrimeFrontmatter("---\r\ndescription: a: b\r\n---\r\n")).toEqual({ text: '---\r\ndescription: "a: b"\r\n---\r\n', keys: ["description"] });
    expect(quotePrimeFrontmatter("---\ntitle: ends with:\n---\n")?.keys).toEqual(["title"]);
  });
  it("returns null for quoted, block and continued values, values without \": \", and text without frontmatter", () => {
    for (const text of [
      '---\ndescription: "a: b"\n---\n', "---\ndescription: 'a: b'\n---\n", "---\ndescription: >\n  a: b\n---\n",
      "---\ndescription: a: b\n  continued\n---\n", "---\ndescription: a:b and a - b\n---\n", "description: a: b\n", "# a: b\n",
    ]) expect(quotePrimeFrontmatter(text)).toBeNull();
  });
  it("stages all 12 of Vega's skills: 11 as symlinks, summarize-status as a dir with the quoted SKILL.md and a symlink per other entry", async () => {
    // Vega's skill set on 2026-10-26: 7 desired + 5 company-required. Frontmatter verbatim; summarize-status gets an extra file.
    await fs.cp(VEGA, path.join(base, "vega"), { recursive: true });
    await fs.writeFile(path.join(base, "vega", "summarize-status--61a9e96dc6", "notes.md"), "extra\n");
    const names = (await fs.readdir(path.join(base, "vega"))).sort();
    const entries = names.map((name) => ({ key: `vega/${name}`, runtimeName: name, source: path.join(base, "vega", name) }));
    const staged = await stagePrimeSkills({ paperclipRuntimeSkills: entries, paperclipSkillSync: { desiredSkills: entries.map((entry) => entry.key) } });
    expect(names).toHaveLength(12);
    expect(staged.skillDirs).toHaveLength(12);
    expect(staged.missing).toEqual([]);
    for (const dir of staged.skillDirs) {
      const quoted = quotePrimeFrontmatter(await fs.readFile(path.join(dir, "SKILL.md"), "utf8"));
      expect(quoted, dir).toBeNull(); // every staged SKILL.md is one Prime can parse
      expect((await fs.lstat(dir)).isSymbolicLink(), dir).toBe(path.basename(dir) !== "summarize-status");
    }
    const summarize = path.join(path.dirname(staged.skillDirs[0]!), "summarize-status");
    const source = path.join(base, "vega", "summarize-status--61a9e96dc6");
    expect(await fs.readFile(path.join(summarize, "SKILL.md"), "utf8")).toBe(
      (await fs.readFile(path.join(source, "SKILL.md"), "utf8")).replace(`description: ${SUMMARIZE}`, `description: ${JSON.stringify(SUMMARIZE)}`));
    expect(await fs.readlink(path.join(summarize, "notes.md"))).toBe(path.join(source, "notes.md"));
    expect(staged.logLines).toContain('[paperclip] Skill "summarize-status--61a9e96dc6" is staged with its frontmatter "description" quoted: an unquoted ": " is invalid YAML, and Prime drops the skill.\n');
    await staged.cleanup();
    expect(await fs.readdir(tmp)).toEqual([]);
    expect(await fs.readFile(path.join(source, "SKILL.md"), "utf8")).toContain(`description: ${SUMMARIZE}\n`); // the source is untouched
  });
  it("puts Prime's diagnostic for a missing explicit skill into the check's reason", async () => {
    const dir = path.join(VEGA, "summarize-status--61a9e96dc6");
    const other = path.join(VEGA, "paperclip");
    const client = { request: async (command: { type: string }) => (command.type === "get_system_prompt" ? { success: true, data: {} } : { success: true, data: {
      skills: [{ name: "paperclip", filePath: path.join(other, "SKILL.md") }], contextFiles: [],
      diagnostics: { skills: [{ type: "warning", message: "description is required", path: path.join(dir, "SKILL.md") }] },
    } }) };
    const check = await checkPrimeSkillList(client, "s-1", [other, dir], true);
    expect(check).toMatchObject({ ok: false, missing: [dir], reason: `explicit skills missing: ${dir} (Prime: description is required)` });
  });
});
