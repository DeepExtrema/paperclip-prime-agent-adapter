// N0 e31 (TAI-273 §2.2 item 10): the shape of get_system_prompt and get_resource_snapshot for a governed-style session:
// both `!**` settings files, one staged skill and the six allowlisted built-ins by path, and an AGENTS.md in cwd. Offline.
import fs from "node:fs";
import path from "node:path";
import { PRIME, createConfig, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const s = scratch("e31-snapshot");
const fake = await startFake(s);
seedAgentDir(s, fake, { settings: { skills: ["!**"], enableBuiltinSkills: false } });
fs.mkdirSync(path.join(s.work, ".prime", "agent"), { recursive: true });
fs.writeFileSync(path.join(s.work, ".prime", "agent", "settings.json"), '{"skills":["!**"]}');
fs.writeFileSync(path.join(s.work, "AGENTS.md"), "# cwd agents\n");
const staged = path.join(s.dir, "staged", "n0-staged");
fs.mkdirSync(staged, { recursive: true });
fs.writeFileSync(path.join(staged, "SKILL.md"), "---\nname: n0-staged\ndescription: staged skill\n---\n# staged\n");
const release = path.dirname(fs.realpathSync(PRIME));
const builtins = ["agent-message", "agent-observe", "attach-image", "compact", "edit", "refine"].map((name) => path.join(release, "skills", name));
const d = await startDaemon(s);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s, { skills: [staged, ...builtins] }) }, 60_000);
  const sid = created.data.activeSessionId;
  const prompt = await d.req({ type: "get_system_prompt", activeSessionId: sid });
  show("get_system_prompt keys", { success: prompt.success, keys: Object.keys(prompt.data ?? {}), chars: JSON.stringify(prompt.data ?? {}).length });
  const snap = await d.req({ type: "get_resource_snapshot", activeSessionId: sid });
  show("get_resource_snapshot keys", { success: snap.success, keys: Object.keys(snap.data ?? {}) });
  show("skills[0]", snap.data?.skills?.[0]);
  show("skills (name, filePath, baseDir, source/scope)", (snap.data?.skills ?? []).map((k) => [k.name, k.filePath, k.baseDir, `${k.sourceInfo?.source}/${k.sourceInfo?.scope}`]));
  show("contextFiles", snap.data?.contextFiles);
  show("other arrays", Object.fromEntries(Object.entries(snap.data ?? {}).filter(([k, v]) => Array.isArray(v) && k !== "skills").map(([k, v]) => [k, v.length])));
  show("diagnostics/warnings", snap.data?.diagnostics ?? snap.data?.warnings ?? null);
  show("release", release);
} finally {
  await d.stop();
  fake.stop();
}
