// N0 e35 (TAI-365): stage real skill sources with the adapter's stagePrimeSkills, pass every staged dir to Prime, and
// list which ones Prime loads. Usage: N0_ADAPTER_DIST=<built dist> e35-staged-skills.mjs <skill source dir>... Offline.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createConfig, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const { stagePrimeSkills } = await import(pathToFileURL(path.join(process.env.N0_ADAPTER_DIST, "server", "skills.js")).href);
const entries = process.argv.slice(2).map((source) => ({ key: `n0/${path.basename(source)}`, runtimeName: path.basename(source), source }));
const staged = await stagePrimeSkills({ paperclipRuntimeSkills: entries, paperclipSkillSync: { desiredSkills: entries.map((entry) => entry.key) } });
show("staged", { skillDirs: staged.skillDirs.length, missing: staged.missing, logLines: staged.logLines });

const s = scratch("e35-staged");
const fake = await startFake(s);
seedAgentDir(s, fake, { settings: { skills: ["!**"], enableBuiltinSkills: false } });
fs.mkdirSync(path.join(s.work, ".prime", "agent"), { recursive: true });
fs.writeFileSync(path.join(s.work, ".prime", "agent", "settings.json"), '{"skills":["!**"]}');
const d = await startDaemon(s);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s, { skills: staged.skillDirs }) }, 60_000);
  const sid = created.data.activeSessionId;
  await d.req({ type: "get_system_prompt", activeSessionId: sid });
  const snap = await d.req({ type: "get_resource_snapshot", activeSessionId: sid });
  const loaded = new Set((snap.data?.skills ?? []).map((k) => path.basename(path.dirname(k.filePath))));
  show("loaded", Object.fromEntries(staged.skillDirs.map((dir) => [path.basename(dir), loaded.has(path.basename(dir))])));
  show("count", { staged: staged.skillDirs.length, loaded: staged.skillDirs.filter((dir) => loaded.has(path.basename(dir))).length });
  show("diagnostics.skills", snap.data?.diagnostics?.skills ?? null);
} finally {
  await d.stop();
  fake.stop();
  await staged.cleanup();
}
