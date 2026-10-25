// N0 addendum C step 5 (TAI-273 plan rev 9, G3 item 5): a bash('sleep 600', persistent=True) in a parent and in a depth-1
// child. Does each record in <agentDir>/persistent-shells/ carry the sessionId that the roster shows for that session?
// Also records each record's pid and start id against /proc, which the reap reads. Offline (scripts/n0/offline.sh).
import fs from "node:fs";
import path from "node:path";
import { createConfig, delay, scratch, seedAgentDir, show, startDaemon, startFake, turn } from "./harness.mjs";

const s = scratch("e33");
const fake = await startFake(s);
seedAgentDir(s, fake);
const shellsDir = path.join(s.agentDir, "persistent-shells");
const startId = (pid) => { try { const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return `proc:${st.slice(st.lastIndexOf(")") + 2).split(" ")[19]}`; } catch { return null; } };
const pgid = (pid) => { try { const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[2]); } catch { return null; } };
const d = await startDaemon(s);
const pids = [];
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  const sid = created.data.activeSessionId;
  // The child's commands are built in Python, so the parent's own text holds no literal marker for the fake to run.
  const child = "'BEGIN' + 'CMD\\np = bash(\"sleep 600\", persistent=True)\\nprint(\"CHILD SHELL\", p)\\nimport asyncio\\nawait asyncio.sleep(30)\\nEND' + 'CMD'";
  await turn(d, sid, `BEGINCMD\np = bash('sleep 600', persistent=True)\nprint('PARENT SHELL', p)\nh = await rlm.spawn(${child}, name='w1')\nprint('CHILD', h)\nimport asyncio\nawait asyncio.sleep(6)\nENDCMD`);
  await delay(1000);
  const rows = (await d.req({ type: "list" })).data?.sessions ?? [];
  show("roster", rows.map((r) => ({ depth: r.rlmDepth, sessionId: r.sessionId, activeSessionId: r.activeSessionId, sessionFile: r.sessionFile })));
  const files = fs.existsSync(shellsDir) ? fs.readdirSync(shellsDir).sort() : [];
  show("persistent-shells/ entries", files);
  const records = files.filter((f) => f.endsWith(".json")).map((f) => ({ file: f, record: JSON.parse(fs.readFileSync(path.join(shellsDir, f), "utf8")) }));
  show("records", records);
  show("record sessionId vs roster", records.map(({ file, record }) => {
    const row = rows.find((r) => r.sessionId === record.sessionId);
    const pid = record.pid ?? record.processId ?? null;
    if (typeof pid === "number") pids.push(pid);
    return { file, sessionId: record.sessionId ?? null, rosterDepth: row ? row.rlmDepth : "no roster row with this sessionId", pid,
      recordedStartId: record.startId ?? record.processStartId ?? null, procStartId: typeof pid === "number" ? startId(pid) : null,
      pidLeadsGroup: typeof pid === "number" ? pgid(pid) === pid : null };
  }));
} finally {
  await d.stop();
  await delay(500);
  show("shell pids alive after an adapter-style stop", pids.map((pid) => [pid, startId(pid) !== null]));
  for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
  fake.stop();
}
show("scratch", s.dir);
