// N0 e34 (TAI-365): which SKILL.md frontmatter Prime drops. The real summarize-status SKILL.md, plus one-change variants:
// the description quoted, its ": " removed, its en dash removed, a short description. Offline.
import fs from "node:fs";
import path from "node:path";
import { createConfig, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const source = process.env.N0_SKILL ?? process.argv[2];
if (!source) throw new Error("usage: e34-skill-frontmatter.mjs <dir with SKILL.md>");
const text = fs.readFileSync(path.join(source, "SKILL.md"), "utf8");
const description = /^description:\s*(.*)$/m.exec(text)[1];
const withDescription = (value) => text.replace(/^description:.*$/m, () => `description: ${value}`);
const variants = {
  "n0-real": text,
  "n0-quoted": withDescription(JSON.stringify(description)),
  "n0-no-colon": withDescription(description.replaceAll(": ", " - ")),
  "n0-no-dash": withDescription(description.replaceAll("–", "-")),
  "n0-short": withDescription("short plain description"),
};

const s = scratch("e34-frontmatter");
const fake = await startFake(s);
seedAgentDir(s, fake, { settings: { skills: ["!**"], enableBuiltinSkills: false } });
fs.mkdirSync(path.join(s.work, ".prime", "agent"), { recursive: true });
fs.writeFileSync(path.join(s.work, ".prime", "agent", "settings.json"), '{"skills":["!**"]}');
const dirs = Object.entries(variants).map(([name, body]) => {
  const dir = path.join(s.dir, "staged", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body.replace(/^name:.*$/m, `name: ${name}`));
  return dir;
});
const d = await startDaemon(s);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s, { skills: dirs }) }, 60_000);
  const sid = created.data.activeSessionId;
  await d.req({ type: "get_system_prompt", activeSessionId: sid });
  const snap = await d.req({ type: "get_resource_snapshot", activeSessionId: sid });
  const loaded = new Set((snap.data?.skills ?? []).map((k) => path.basename(path.dirname(k.filePath))));
  show("loaded per variant", Object.fromEntries(Object.keys(variants).map((name) => [name, loaded.has(name)])));
  show("snapshot keys", Object.keys(snap.data ?? {}));
  show("diagnostics", Object.fromEntries(Object.entries(snap.data ?? {}).filter(([k]) => /diag|warn|error/i.test(k))));
} finally {
  await d.stop();
  fake.stop();
}
