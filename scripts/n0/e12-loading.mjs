// N0 e12: what 0.10.1 loads at session start.
//  - Skills passed in the create config: a name that does not match its directory (and has "--"), a matching one, and one named like a built-in.
//  - <cwd>/.prime/agent/: settings.json (rlmMaxDepth over the agent dir's value), APPEND_SYSTEM.md, AGENTS.md, skills/, prompts/, models.json.
//  - <cwd>/AGENTS.md, <cwd>/CLAUDE.md, an AGENTS.md in cwd's parent, and the agent dir's AGENTS.md and APPEND_SYSTEM.md.
// Usage: node e12-loading.mjs [system]   "system" adds <cwd>/.prime/agent/SYSTEM.md and <agentDir>/SYSTEM.md instead.
import fs from "node:fs";
import path from "node:path";
import { bodies, createConfig, requests, scratch, seedAgentDir, show, startDaemon, startFake, turn } from "./harness.mjs";

const mode = process.argv[2] ?? "files";
const s = scratch(`e12-${mode}`);
const fake = await startFake(s);
seedAgentDir(s, fake, { settings: { rlmMaxDepth: 1 } });
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (dir, name, marker) => put(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${marker} skill description\n---\n\n# ${name}\n${marker} body\n`);
const staged = path.join(s.dir, "staged");
skill(path.join(staged, "simplified-english--9876d8956d"), "simplified-english", "N0MISMATCH");
skill(path.join(staged, "good-skill"), "good-skill", "N0MATCH");
skill(path.join(staged, "goal"), "goal", "N0BUILTINCLASH");
const proj = path.join(s.work, ".prime", "agent");
const MARKERS = ["N0MISMATCH", "N0MATCH", "N0BUILTINCLASH", "N0PROJAPPEND", "N0PROJAGENTS", "N0PROJSKILL", "N0PROJPROMPT", "N0CWDAGENTS", "N0CWDCLAUDE",
  "N0PARENTAGENTS", "N0AGENTDIRAGENTS", "N0AGENTDIRAPPEND", "N0PROJSYSTEM", "N0AGENTDIRSYSTEM"];
if (mode === "system") {
  put(path.join(proj, "SYSTEM.md"), "N0PROJSYSTEM project system prompt");
  put(path.join(s.agentDir, "SYSTEM.md"), "N0AGENTDIRSYSTEM agent dir system prompt");
} else {
  put(path.join(proj, "settings.json"), JSON.stringify({ rlmMaxDepth: 3 }));
  put(path.join(proj, "APPEND_SYSTEM.md"), "N0PROJAPPEND project append");
  put(path.join(proj, "AGENTS.md"), "N0PROJAGENTS project .prime/agent AGENTS.md");
  skill(path.join(proj, "skills", "n0-proj-skill"), "n0-proj-skill", "N0PROJSKILL");
  put(path.join(proj, "prompts", "n0prompt.md"), "---\ndescription: N0PROJPROMPT template\n---\nN0PROJPROMPT body");
  put(path.join(proj, "models.json"), JSON.stringify({ providers: { n0proj: { baseUrl: fake.url, api: "anthropic-messages", apiKey: "n0", models: [{ id: "n0-proj-model" }] } } }));
  put(path.join(s.work, "AGENTS.md"), "N0CWDAGENTS cwd AGENTS.md");
  put(path.join(s.work, "CLAUDE.md"), "N0CWDCLAUDE cwd CLAUDE.md");
  put(path.join(s.dir, "AGENTS.md"), "N0PARENTAGENTS parent AGENTS.md");
  put(path.join(s.agentDir, "AGENTS.md"), "N0AGENTDIRAGENTS agent dir AGENTS.md");
  put(path.join(s.agentDir, "APPEND_SYSTEM.md"), "N0AGENTDIRAPPEND agent dir append");
}
const d = await startDaemon(s);
try {
  const skills = fs.readdirSync(staged).map((n) => path.join(staged, n));
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s, { skills }) }, 60_000);
  show("create", { success: created.success, error: created.error ?? null });
  const sid = created.data.activeSessionId;
  show("get_commands", ((await d.req({ type: "get_commands", activeSessionId: sid })).data?.commands ?? []).map((c) => `${c.name}${c.source ? ` (${c.source})` : ""}${c.location ? ` @ ${c.location}` : ""}`));
  show("get_rlm_max_depth_status (agent dir 1, project 3 in 'files' mode)", (await d.req({ type: "get_rlm_max_depth_status", activeSessionId: sid })).data);
  const models = (await d.req({ type: "get_available_models", activeSessionId: sid })).data;
  show("available models from provider n0proj", JSON.stringify(models ?? {}).includes("n0-proj-model") ? "present" : "absent");
  const snapshot = (await d.req({ type: "get_resource_snapshot", activeSessionId: sid })).data;
  show("resource snapshot (first 3000 chars)", JSON.stringify(snapshot ?? {}).slice(0, 3000));
  const r0 = requests(s).length;
  await turn(d, sid, "SAY<<<hello>>>");
  const sys = requests(s)[r0]?.system ?? "";
  const body = JSON.stringify(bodies(s)[r0] ?? {});
  show("markers in system prompt", MARKERS.filter((m) => sys.includes(m)));
  show("markers anywhere in the first request", MARKERS.filter((m) => body.includes(m)));
  show("system prompt starts", sys.slice(0, 300));
  const avail = /<available_skills>[\s\S]*?<\/available_skills>/.exec(sys)?.[0] ?? "(no available_skills block)";
  show("available_skills block", avail.slice(0, 4000));
  show("logs mentioning skills", fs.readdirSync(path.join(s.agentDir, "logs")).flatMap((f) => fs.readFileSync(path.join(s.agentDir, "logs", f), "utf8").split("\n")).filter((l) => /skill|name/i.test(l)).slice(0, 20));
  fs.writeFileSync(path.join(s.dir, "system.txt"), sys);
} finally {
  await d.stop();
  fake.stop();
}
show("daemon output mentioning skills", d.output().split("\n").filter((l) => /skill/i.test(l)).slice(0, 20));
show("scratch", s.dir);
