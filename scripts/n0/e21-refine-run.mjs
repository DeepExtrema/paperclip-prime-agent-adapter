// N0 e21: the model-side path, `await refine.run(global_=True)` (and local), against the fake refiner: which files it writes,
// and whether its global prompt edit reaches a new session.
import { bodies, createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake, tree, turn } from "./harness.mjs";
import { toolResults } from "./session-file.mjs";

const s = scratch("e21");
const fake = await startFake(s);
seedAgentDir(s, fake);
{
  const d = await startDaemon(s);
  try {
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
    await turn(d, created.data.activeSessionId, "BEGINCMD\nprint('LOCAL', await refine.run('N0 local probe'))\nprint('GLOBAL', await refine.run('N0 global probe', global_=True))\nENDCMD");
    await delay(3000);
    show("tool results", toolResults(created.data.sessionFile).map((t) => t.slice(0, 600)));
  } finally { await d.stop(); }
}
show("harness files", tree(s.agentDir).filter((p) => /harness_state|refinement_history/.test(p)));
{
  const d = await startDaemon(s);
  try {
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
    const r0 = requests(s).length;
    await turn(d, created.data.activeSessionId, "SAY<<<hello>>>");
    show("new session: N0REFINEPROMPT in its first request", JSON.stringify(bodies(s)[r0] ?? {}).includes("N0REFINEPROMPT"));
  } finally { await d.stop(); }
}
fake.stop();
