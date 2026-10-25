// N0 e13: settings precedence between <cwd>/.prime/agent/settings.json and <agentDir>/settings.json, and how far up from cwd
// Prime looks for AGENTS.md / CLAUDE.md.
import fs from "node:fs";
import path from "node:path";
import { createConfig, requests, scratch, seedAgentDir, show, startDaemon, startFake, turn } from "./harness.mjs";

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
async function probe(label, { agentSettings = {}, setup }) {
  const s = scratch("e13");
  const fake = await startFake(s);
  seedAgentDir(s, fake, { settings: agentSettings });
  const cwd = path.join(s.dir, "x", "y", "work");
  fs.mkdirSync(cwd, { recursive: true });
  setup(s, cwd);
  const d = await startDaemon(s, { cwd });
  try {
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s, { cwd }) }, 60_000);
    const sid = created.data.activeSessionId;
    const depth = (await d.req({ type: "get_rlm_max_depth_status", activeSessionId: sid })).data;
    const r0 = requests(s).length;
    await turn(d, sid, "SAY<<<hello>>>");
    const sys = requests(s)[r0]?.system ?? "";
    show(label, { rlmMaxDepth: depth, markers: [...sys.matchAll(/N0[A-Z0-9_]+/g)].map((m) => m[0]).filter((v, i, a) => a.indexOf(v) === i) });
  } finally {
    await d.stop();
    fake.stop();
  }
}
await probe("project-only rlmMaxDepth 3", { setup: (_s, cwd) => put(path.join(cwd, ".prime", "agent", "settings.json"), JSON.stringify({ rlmMaxDepth: 3 })) });
await probe("agent 1, project 3", { agentSettings: { rlmMaxDepth: 1 }, setup: (_s, cwd) => put(path.join(cwd, ".prime", "agent", "settings.json"), JSON.stringify({ rlmMaxDepth: 3 })) });
await probe("CLAUDE.md only in cwd and in cwd's parent", { setup: (_s, cwd) => { put(path.join(cwd, "CLAUDE.md"), "N0CWDCLAUDE"); put(path.join(cwd, "..", "CLAUDE.md"), "N0PARENTCLAUDE"); } });
await probe("AGENTS.md two and three levels up", { setup: (s, cwd) => { put(path.join(cwd, "..", "..", "AGENTS.md"), "N0TWOUP"); put(path.join(s.dir, "AGENTS.md"), "N0THREEUP"); } });
await probe("same, with a .git dir one level up", { setup: (s, cwd) => { fs.mkdirSync(path.join(cwd, "..", ".git"), { recursive: true }); put(path.join(cwd, "..", "..", "AGENTS.md"), "N0TWOUP"); put(path.join(s.dir, "AGENTS.md"), "N0THREEUP"); } });
await probe("both AGENTS.md and CLAUDE.md in cwd", { setup: (_s, cwd) => { put(path.join(cwd, "AGENTS.md"), "N0CWDAGENTS"); put(path.join(cwd, "CLAUDE.md"), "N0CWDCLAUDE"); } });
