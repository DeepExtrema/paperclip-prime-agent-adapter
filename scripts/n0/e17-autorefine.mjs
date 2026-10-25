// N0 e17: does autoRefine run a background review (an extra model request) every turnInterval assistant turns, and does
// autoRefine.enabled=false stop it? Also checks that harnessRefinements true + autoRefine off keeps create_memory/search working.
// Usage: node e17-autorefine.mjs '<settings JSON>'
import { createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake, turn } from "./harness.mjs";
import { toolResults } from "./session-file.mjs";

const settings = JSON.parse(process.argv[2] ?? "{}");
const s = scratch("e17");
const fake = await startFake(s);
seedAgentDir(s, fake, { settings });
const d = await startDaemon(s);
try {
  const config = createConfig(s);
  if (process.env.N0_NO_SERIALIZED_REFINE) delete config.serializedRefine;
  const created = await d.req({ type: "create", lifecycle: "resident", config }, 60_000);
  const sid = created.data.activeSessionId;
  await d.req({ type: "attach", activeSessionId: sid });
  for (let i = 1; i <= Number(process.env.N0_TURNS ?? 5); i += 1) await turn(d, sid, `SAY<<<turn ${i}>>>`);
  await turn(d, sid, "BEGINCMD\ne = rlm.harness.create_memory('N0 fact', 'N0AUTOREFINEMEMORY value', global_=True)\nprint('CREATED', e.id)\nprint('SEARCH', [x.id for x in rlm.harness.search('N0AUTOREFINEMEMORY', global_=True)])\nENDCMD");
  await delay(5000);
  const reqs = requests(s);
  show("settings", settings);
  show("requests", reqs.map((r) => ({ lastUserText: r.lastUserText.slice(0, 80).replace(/\n/g, " "), systemStart: r.system.slice(0, 80).replace(/\n/g, " "), messages: r.messageCount })));
  show("requests not caused by this script's prompts", reqs.filter((r) => !/^SAY<<<turn \d+>>>$|BEGINCMD/.test(r.lastUserText.trim())).map((r) => ({ lastUserText: r.lastUserText.slice(0, 300), systemStart: r.system.slice(0, 200) })));
  show("events mentioning refine", d.events.filter((e) => JSON.stringify(e).toLowerCase().includes("refine") && e.type !== "roster_update").map((e) => JSON.stringify(e).slice(0, 300)).slice(0, 10));
  show("memory tool result", toolResults(created.data.sessionFile).slice(-1));
} finally {
  await d.stop();
  fake.stop();
}
