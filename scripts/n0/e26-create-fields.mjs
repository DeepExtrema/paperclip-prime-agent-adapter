// N0 e26 (plan rev 5, 2.2 item 10): does any daemon `create` config field turn off skill, prompt template or context file
// discovery in 0.10.1? Each candidate gets its own session in one daemon; the resource snapshot (which matched the
// system prompt's <available_skills> in e24) is counted by source. No model request is made.
import fs from "node:fs";
import path from "node:path";
import { createConfig, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const s = scratch("e26");
const fake = await startFake(s);
seedAgentDir(s, fake);
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (dir, name) => put(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`);
skill(path.join(s.agentDir, "skills", "n0-agentdir"), "n0-agentdir");
skill(path.join(s.work, ".agents", "skills", "n0-cwdagents"), "n0-cwdagents");
skill(path.join(s.home, ".agents", "skills", "n0-home"), "n0-home");
const staged = path.join(s.dir, "staged", "n0-staged");
skill(staged, "n0-staged");
put(path.join(s.agentDir, "prompts", "n0tmpl.md"), "---\ndescription: n0 template\n---\nbody");
put(path.join(s.work, "AGENTS.md"), "N0CWDAGENTS");
const CANDIDATES = [
  {}, { noSkills: true }, { noContextFiles: true }, { noPromptTemplates: true }, { noThemes: true },
  { skillDiscovery: false }, { skillDiscovery: "off" }, { discoverSkills: false }, { disableSkillDiscovery: true }, { noSkillDiscovery: true },
  { includeDefaultSkills: false }, { enableBuiltinSkills: false }, { builtinSkills: false }, { discovery: false }, { noDiscovery: true },
  { resources: { noSkills: true } }, { resources: { skills: false } }, { resourceSelection: "explicit" }, { resourceSelection: "none" },
  { settings: { enableBuiltinSkills: false } }, { executionMode: "headless", noSkills: true },
];
const d = await startDaemon(s);
const rows = [];
try {
  for (const extra of CANDIDATES) {
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s, { skills: [staged], ...extra }) }, 60_000);
    if (!created.success) { rows.push({ extra, error: created.error }); continue; }
    const sid = created.data.activeSessionId;
    // Resources load lazily: the snapshot is empty until a command such as get_commands has run.
    const commands = (await d.req({ type: "get_commands", activeSessionId: sid })).data?.commands ?? [];
    const snap = (await d.req({ type: "get_resource_snapshot", activeSessionId: sid })).data ?? {};
    const by = {};
    for (const k of snap.skills ?? []) by[k.sourceInfo?.source ?? "?"] = (by[k.sourceInfo?.source ?? "?"] ?? 0) + 1;
    rows.push({ extra, skillsBySource: by, found: (snap.skills ?? []).filter((k) => k.name.startsWith("n0-")).map((k) => k.name).sort().join(","),
      prompts: (snap.prompts ?? []).length, commands: commands.length, contextFiles: (snap.contextFiles ?? []).length });
    await d.req({ type: "kill", activeSessionId: sid }).catch(() => undefined);
  }
} finally {
  await d.stop();
  fake.stop();
}
for (const r of rows) console.log(JSON.stringify(r));
show("scratch", s.dir);
