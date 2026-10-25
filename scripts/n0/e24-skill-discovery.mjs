// N0 e24 (plan rev 5, 2.2 items 9 and 10): skill discovery in a daemon session, the built-ins a default session loads,
// and whether a prompt template reaches the model without a user typing it.
//  - A skill in each found place: <agentDir>/skills/<dir>, a loose <agentDir>/skills/x.md, <cwd>/.prime/agent/skills/,
//    <cwd>/.agents/skills/, a parent's .agents/skills/, $HOME/.agents/skills/, and a path in settings.json `skills`.
//  - One skill passed by path in the create config's `skills`, and (with "builtins") every <release>/skills/<name> too.
//  - Prompt templates in <agentDir>/prompts/ and <cwd>/.prime/agent/prompts/.
//  - The parent spawns a depth-1 child and a depth-0 create_session session; their skill lists are read from their requests.
// Usage: node e24-skill-discovery.mjs '<extra create config JSON>' [builtins]
//   N0_SETTINGS='<JSON>' replaces the agent dir's settings.json (default: `skills` holds the settings skill's path).
//   N0_PROJECT_SETTINGS='<JSON>' writes <cwd>/.prime/agent/settings.json.
import fs from "node:fs";
import path from "node:path";
import { PRIME, bodies, createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake, turn } from "./harness.mjs";

const extra = JSON.parse(process.argv[2] ?? "{}");
const withBuiltins = process.argv[3] === "builtins";
const s = scratch(`e24-${Object.keys(extra).join("+") || "default"}${withBuiltins ? "-builtins" : ""}${process.env.N0_SETTINGS ? "-settings" : ""}${process.env.N0_PROJECT_SETTINGS ? "-project" : ""}`);
const fake = await startFake(s);
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skillText = (name, marker) => `---\nname: ${name}\ndescription: ${marker} skill description\n---\n\n# ${name}\n${marker} body\n`;
const skill = (dir, name, marker) => put(path.join(dir, "SKILL.md"), skillText(name, marker));
const cwd = path.join(s.dir, "x", "y", "work");
fs.mkdirSync(cwd, { recursive: true });
const settingsSkill = path.join(s.dir, "settings-skills", "n0-settings");
seedAgentDir(s, fake, { settings: process.env.N0_SETTINGS ? JSON.parse(process.env.N0_SETTINGS) : { skills: [settingsSkill] } });
skill(path.join(s.agentDir, "skills", "n0-agentdir"), "n0-agentdir", "N0AGENTDIRSKILL");
put(path.join(s.agentDir, "skills", "n0-loose.md"), skillText("n0-loose", "N0LOOSESKILL"));
skill(path.join(cwd, ".prime", "agent", "skills", "n0-proj"), "n0-proj", "N0PROJSKILL");
skill(path.join(cwd, ".agents", "skills", "n0-cwdagents"), "n0-cwdagents", "N0CWDAGENTSSKILL");
skill(path.join(s.dir, "x", ".agents", "skills", "n0-parent"), "n0-parent", "N0PARENTSKILL");
skill(path.join(s.home, ".agents", "skills", "n0-home"), "n0-home", "N0HOMESKILL");
skill(settingsSkill, "n0-settings", "N0SETTINGSSKILL");
if (process.env.N0_PROJECT_SETTINGS) put(path.join(cwd, ".prime", "agent", "settings.json"), process.env.N0_PROJECT_SETTINGS);
const staged = path.join(s.dir, "staged", "n0-staged");
skill(staged, "n0-staged", "N0STAGEDSKILL");
put(path.join(s.agentDir, "prompts", "n0tmpl-agent.md"), "---\ndescription: N0AGENTPROMPTDESC template\n---\nN0AGENTPROMPTBODY body");
put(path.join(cwd, ".prime", "agent", "prompts", "n0tmpl-proj.md"), "---\ndescription: N0PROJPROMPTDESC template\n---\nN0PROJPROMPTBODY body");
const releaseSkills = path.join(path.dirname(PRIME), "skills");
const builtins = fs.readdirSync(releaseSkills).filter((n) => fs.existsSync(path.join(releaseSkills, n, "SKILL.md")));
const MARKERS = ["N0AGENTDIRSKILL", "N0LOOSESKILL", "N0PROJSKILL", "N0CWDAGENTSSKILL", "N0PARENTSKILL", "N0HOMESKILL", "N0SETTINGSSKILL", "N0STAGEDSKILL",
  "N0AGENTPROMPTDESC", "N0AGENTPROMPTBODY", "N0PROJPROMPTDESC", "N0PROJPROMPTBODY"];
const names = (sys) => [...sys.matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1]).sort();
const found = (text) => MARKERS.filter((m) => text.includes(m));

const d = await startDaemon(s, { cwd });
try {
  const skills = [staged, ...(withBuiltins ? builtins.map((n) => path.join(releaseSkills, n)) : [])];
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s, { cwd, skills, ...extra }) }, 60_000);
  show(`create ${JSON.stringify(extra)}${withBuiltins ? " + every built-in by path" : ""}`, { success: created.success, error: created.error ?? null });
  const sid = created.data.activeSessionId;
  show("get_commands", ((await d.req({ type: "get_commands", activeSessionId: sid })).data?.commands ?? []).map((c) => `${c.name} (${c.source ?? "?"})`));
  const snap = (await d.req({ type: "get_resource_snapshot", activeSessionId: sid })).data ?? {};
  show("snapshot skills", (snap.skills ?? []).map((k) => `${k.name} ${k.sourceInfo?.source}/${k.sourceInfo?.scope} @ ${k.filePath}`));
  show("snapshot keys and prompt templates", { keys: Object.keys(snap), promptTemplates: (snap.promptTemplates ?? snap.prompts ?? []).map((p) => p.name ?? p.filePath ?? p) });

  const r0 = requests(s).length;
  const make = [
    "h = await rlm.spawn('SAY<<<child-reply>>>', name='w1')\nprint('COLLECT', await rlm.collect(h, timeout_ms=30000))",
    "h2 = await rlm.create_session('SAY<<<session-reply>>>', name='s1')\nimport asyncio\nawait asyncio.sleep(4)\nprint('SESSION', h2)",
    "h3 = await rlm.spawn('/n0tmpl-agent', name='w2')\nprint('COLLECT2', await rlm.collect(h3, timeout_ms=30000))",
  ].map((c) => `BEGINCMD\n${c}\nENDCMD`).join("\n");
  await turn(d, sid, make);
  await delay(1500);
  const reqs = requests(s);
  const all = bodies(s);
  const first = reqs[r0];
  show("parent: <available_skills> names", names(first?.system ?? ""));
  show("parent: markers in the first request (system and messages)", found(JSON.stringify(all[r0] ?? {})));
  // The parent's own later requests repeat the BEGINCMD text, which holds both needles; skip them (Sentinel, TAI-337).
  const byUser = (needle) => reqs.findIndex((r, i) => i > r0 && (r.lastUserText ?? "").includes(needle) && !(r.lastUserText ?? "").includes("BEGINCMD"));
  for (const [label, needle] of [["depth-1 child", "child-reply"], ["create_session session", "session-reply"]]) {
    const i = byUser(needle);
    show(`${label}: <available_skills> names`, i < 0 ? "(no request found)" : names(reqs[i].system ?? ""));
    show(`${label}: markers in its first request`, i < 0 ? [] : found(JSON.stringify(all[i] ?? {})));
  }
  // A child prompt that the model wrote, "/n0tmpl-agent": is it expanded to the template body?
  const t = reqs.findIndex((r, i) => i > r0 && /n0tmpl-agent|N0AGENTPROMPTBODY/.test(r.lastUserText ?? "") && !(r.lastUserText ?? "").includes("BEGINCMD"));
  show("model-written child prompt '/n0tmpl-agent': child's last user text", t < 0 ? "(no request found)" : reqs[t].lastUserText.slice(0, 300));

  // Control: the same template typed as a user prompt.
  const r1 = requests(s).length;
  await turn(d, sid, "/n0tmpl-agent");
  show("control, user types '/n0tmpl-agent': last user text sent to the model", requests(s)[r1]?.lastUserText?.slice(0, 300) ?? "(no request)");
  show("skills/ under the agent dir at the end", fs.readdirSync(path.join(s.agentDir, "skills")));
} finally {
  await d.stop();
  fake.stop();
}
show("scratch", s.dir);
