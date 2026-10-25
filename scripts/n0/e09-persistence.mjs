// N0 e09: what one session leaves for later sessions.
//  Session A writes one global harness entry of each kind (and one local prompt note) with unique markers, and one RLM heartbeat.
//  Session B (new daemon, new session) and session A resumed (new daemon) each run one turn; the fake server records their system prompts.
//  Also records: harness, refinement-history and scheduled-jobs paths; the settings.json Prime leaves; anything under <agentDir>/skills.
import fs from "node:fs";
import path from "node:path";
import { bodies, createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake, tree, turn } from "./harness.mjs";
import { toolResults } from "./session-file.mjs";

const s = scratch("e09");
const fake = await startFake(s);
seedAgentDir(s, fake);
const MARKERS = ["N0MEMCONTENT", "N0PROMPTCONTENT", "N0SKILLCONTENT", "N0SUBCONTENT", "N0FACTORYCONTENT", "N0LOCALPROMPTCONTENT", "N0HBINSTRUCTION"];
const write = `BEGINCMD
import os, json
h = rlm.harness
out = {}
for kind, fn in (("memory", lambda: h.create_memory("N0 memory", "N0MEMCONTENT marker fact", global_=True)),
                 ("prompt", lambda: h.create_prompt_note("N0 prompt", "N0PROMPTCONTENT always answer in French", global_=True)),
                 ("skill", lambda: h.create_skill("N0 skill", "N0SKILLCONTENT use the n0 tool", reference={"type": "python", "import": "json", "callable": "dumps"}, global_=True)),
                 ("subagent", lambda: h.create_subagent("N0 subagent", "N0SUBCONTENT reviewer spec", global_=True)),
                 ("factory", lambda: h.create_factory("N0 factory", "N0FACTORYCONTENT", global_=True)),
                 ("local prompt", lambda: h.create_prompt_note("N0 local prompt", "N0LOCALPROMPTCONTENT local only"))):
    try:
        out[kind] = fn().id
    except Exception as e:
        out[kind] = f"FAILED {type(e).__name__}: {e}"
print("CREATED", json.dumps(out))
try:
    print("HEARTBEAT", await rlm_heartbeat.create("N0HBINSTRUCTION check", interval="@hourly", label="n0"))
except Exception as e:
    print("HEARTBEAT FAILED", type(e).__name__, e)
print("ENV", {k: v for k, v in os.environ.items() if k.startswith(("RLM_", "PRIME_AGENT_"))})
print("SEARCH", h.search("N0MEMCONTENT", global_=True))
ENDCMD`;
const hits = (text) => MARKERS.filter((m) => text.includes(m));
let fileA;
{
  const d = await startDaemon(s);
  try {
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
    fileA = created.data.sessionFile;
    const r0 = requests(s).length;
    await turn(d, created.data.activeSessionId, write);
    show("session A tool results", toolResults(fileA));
    show("session A: markers in the system prompt of the request after the writes", requests(s).slice(r0).map((r) => hits(r.system)));
    const r1 = requests(s).length;
    await turn(d, created.data.activeSessionId, "SAY<<<second turn in A>>>");
    show("session A, next turn: markers in system prompt", requests(s).slice(r1).map((r) => hits(r.system)));
    show("session A roster", (await d.req({ type: "list" })).data.sessions.map((r) => ({ id: r.activeSessionId, hasRegisteredCronJob: r.hasRegisteredCronJob })));
    show("heartbeats_list", await d.req({ type: "heartbeats_list", activeSessionId: created.data.activeSessionId }));
    show("cron_list", await d.req({ type: "cron_list", activeSessionId: created.data.activeSessionId }));
  } finally {
    await d.stop();
  }
}
show("agent dir after session A", tree(s.agentDir).filter((p) => !p.startsWith("logs/") && !p.startsWith("daemon-workers/")));
show("settings.json after session A", fs.readFileSync(path.join(s.agentDir, "settings.json"), "utf8"));
const globalFile = path.join(s.agentDir, "harness", "harness_state.json");
if (fs.existsSync(globalFile)) {
  const g = JSON.parse(fs.readFileSync(globalFile, "utf8"));
  show("global harness_state.json top-level keys", Object.keys(g));
  show("global entries by kind", Object.fromEntries(Object.entries(g.entries ?? {}).map(([k, v]) => [k, Object.keys(v)])));
}
for (const label of ["new session B", "session A resumed"]) {
  await delay(300);
  const d = await startDaemon(s);
  try {
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s), ...(label.includes("resumed") ? { sessionPath: fileA } : {}) }, 60_000);
    await delay(1500);
    show(`${label}: roster at create`, (await d.req({ type: "list" })).data.sessions.map((r) => ({ id: r.activeSessionId, hasRegisteredCronJob: r.hasRegisteredCronJob })));
    const r0 = requests(s).length;
    await turn(d, created.data.activeSessionId, "SAY<<<hello>>>");
    const req = requests(s).slice(r0)[0];
    show(`${label}: markers in the system prompt`, hits(req?.system ?? ""));
    show(`${label}: markers anywhere in the request body (system, messages, tools)`, hits(JSON.stringify(bodies(s)[r0] ?? {})));
    show(`${label}: tools`, req?.tools);
    show(`${label}: heartbeats_list`, (await d.req({ type: "heartbeats_list", activeSessionId: created.data.activeSessionId })).data);
    fs.writeFileSync(path.join(s.dir, `system-${label.replace(/ /g, "-")}.txt`), req?.system ?? "");
  } finally {
    await d.stop();
  }
}
fake.stop();
show("files named scheduled-jobs*", tree(s.agentDir).filter((p) => p.includes("scheduled-jobs")));
show("files named refinement_history*", tree(s.agentDir).filter((p) => p.includes("refinement_history")));
show("harness dirs", tree(s.agentDir).filter((p) => p.includes("harness")));
show("anything under agentDir/skills", tree(path.join(s.agentDir, "skills")));
show("scratch", s.dir);
