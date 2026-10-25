// N0 e27 (plan rev 5, 2.2 item 10): do settings.json skill filters turn discovery off in a 0.10.1 daemon session?
// The 0.8 TypeScript source has `enableBuiltinSkills` and `!pattern` / `-path` overrides in `skills`; 0.10.1 is a Rust
// rewrite, so each is tried here. One scratch agent dir and daemon per variant; no model request is made.
import fs from "node:fs";
import path from "node:path";
import { createConfig, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (dir, name) => put(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`);
const VARIANTS = [
  {}, { enableBuiltinSkills: false }, { skills: ["!**"] }, { skills: ["!**/*"] }, { skills: ["!*"] },
  { enableBuiltinSkills: false, skills: ["!**"] }, { enableSkillCommands: false },
];
const rows = [];
for (const settings of VARIANTS) {
  const s = scratch("e27");
  const fake = await startFake(s);
  seedAgentDir(s, fake, { settings });
  skill(path.join(s.agentDir, "skills", "n0-agentdir"), "n0-agentdir");
  skill(path.join(s.work, ".agents", "skills", "n0-cwdagents"), "n0-cwdagents");
  skill(path.join(s.home, ".agents", "skills", "n0-home"), "n0-home");
  const staged = path.join(s.dir, "staged", "n0-staged");
  skill(staged, "n0-staged");
  const d = await startDaemon(s);
  try {
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s, { skills: [staged] }) }, 60_000);
    if (!created.success) { rows.push({ settings, error: created.error }); continue; }
    const sid = created.data.activeSessionId;
    await d.req({ type: "get_commands", activeSessionId: sid });
    const snap = (await d.req({ type: "get_resource_snapshot", activeSessionId: sid })).data ?? {};
    const by = {};
    for (const k of snap.skills ?? []) by[k.sourceInfo?.source ?? "?"] = (by[k.sourceInfo?.source ?? "?"] ?? 0) + 1;
    rows.push({ settings, skillsBySource: by, found: (snap.skills ?? []).filter((k) => k.name.startsWith("n0-")).map((k) => k.name).sort().join(","),
      diagnostics: JSON.stringify(snap.diagnostics ?? null).slice(0, 300) });
  } finally {
    await d.stop();
    fake.stop();
  }
}
for (const r of rows) console.log(JSON.stringify(r));
show("done", rows.length);
