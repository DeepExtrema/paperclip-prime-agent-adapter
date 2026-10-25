// N0 e20: run the daemon `refine` command (session scope and global scope) against the fake model and list the files it leaves,
// to find refinement_history.jsonl.
import path from "node:path";
import { bodies, createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake, tree, turn } from "./harness.mjs";

const s = scratch("e20");
const fake = await startFake(s);
seedAgentDir(s, fake);
const d = await startDaemon(s);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  const sid = created.data.activeSessionId;
  await turn(d, sid, "SAY<<<a first turn>>>");
  const before = new Set(tree(s.agentDir));
  const r0 = requests(s).length;
  show("refine (local)", await d.req({ type: "refine", activeSessionId: sid, instructions: "N0 refine probe" }, 120_000).catch((e) => ({ error: e.message })));
  show("refine (global)", await d.req({ type: "refine", activeSessionId: sid, instructions: "N0 refine probe", global: true }, 120_000).catch((e) => ({ error: e.message })));
  await delay(2000);
  show("model requests made by refine", requests(s).slice(r0).map((r) => ({ system: r.system.slice(0, 160), last: r.lastUserText.slice(0, 160) })));
  show("new files", tree(s.agentDir).filter((p) => !before.has(p) && !p.startsWith("logs/") && !p.startsWith("daemon-workers/")));
} finally {
  await d.stop();
}
show("refinement_history anywhere", tree(s.agentDir).filter((p) => p.includes("refinement")));
show("harness_state.json anywhere", tree(s.agentDir).filter((p) => p.endsWith("harness_state.json")));
// Does the refine-written global prompt reach a new session, and where does the kernel put its stores in this layout?
{
  const d2 = await startDaemon(s);
  try {
    const created = await d2.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
    const r0 = requests(s).length;
    await turn(d2, created.data.activeSessionId, "BEGINCMD\nimport os\nprint('ENV', {k: v for k, v in os.environ.items() if k.startswith('RLM_')})\nprint('GLOBAL', rlm.harness.overview(global_=True)[:600])\nENDCMD");
    const first = requests(s)[r0];
    show("new session: N0REFINEPROMPT in the first request", JSON.stringify(bodies(s)[r0] ?? {}).includes("N0REFINEPROMPT"));
    show("new session: kernel view", (await import("./session-file.mjs")).toolResults(created.data.sessionFile));
  } finally {
    await d2.stop();
  }
}
show("scratch", path.basename(s.dir));
fake.stop();
