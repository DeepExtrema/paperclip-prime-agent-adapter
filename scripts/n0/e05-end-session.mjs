// N0 e05: which daemon command ends one session so that a later agent_message.send to it fails?
// Usage: node e05-end-session.mjs <kill|cancel_rlm_child|delete_rlm_subagent|abort> <child|session>
//   child:   a depth-1 rlm.spawn child.   session: a depth-0 rlm.create_session session (a sibling root).
// Also records: roster rows, rlm_child_update and roster_update events, workers' process groups.
import { execFileSync } from "node:child_process";
import { createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake, turn } from "./harness.mjs";
import { toolResults } from "./session-file.mjs";

const [command, kind] = process.argv.slice(2);
const s = scratch(`e05-${command}-${kind}`);
const fake = await startFake(s);
seedAgentDir(s, fake);
const d = await startDaemon(s);
const brief = (row) => ({ activeSessionId: row.activeSessionId, rlmDepth: row.rlmDepth, lifecycle: row.lifecycle, activity: row.activity, runtimeKind: row.runtimeKind,
  isSessionActive: row.isSessionActive, workerPid: row.workerPid, name: row.name ?? row.sessionName ?? null, parent: row.parentActiveSessionId ?? row.parentSessionId ?? null,
  rlmChildId: row.rlmChildId ?? null, status: row.status ?? null, messageCount: row.messageCount });
const roster = async () => (await d.req({ type: "list" })).data.sessions.map(brief);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  const sid = created.data.activeSessionId;
  await d.req({ type: "attach", activeSessionId: sid });
  show("roster_subscribe", await d.req({ type: "roster_subscribe" }));
  const make = kind === "child"
    ? "h = await rlm.spawn('SAY<<<child-reply>>>', name='w1')\nr = await rlm.collect(h, timeout_ms=30000)\nprint('HANDLE', h)\nprint('COLLECT', r)"
    : "h = await rlm.create_session('SAY<<<session-reply>>>', name='s1')\nprint('HANDLE', h)\nimport asyncio\nawait asyncio.sleep(3)";
  show("turn 1", (await turn(d, sid, `BEGINCMD\n${make}\nENDCMD`)).prompt);
  await delay(1000);
  const rows1 = await roster();
  show("roster after turn 1", rows1);
  const fullRows = (await d.req({ type: "list" })).data.sessions;
  const target = fullRows.find((r) => r.activeSessionId !== sid);
  show("full roster row of the other session", target);
  for (const pid of [d.pid, ...d.workers]) {
    try { show(`ps ${pid}`, execFileSync("ps", ["-o", "pid,pgid,sid,comm", "-p", String(pid)]).toString()); } catch { show(`ps ${pid}`, "gone"); }
  }
  const childId = target?.rlmChildId ?? target?.id ?? target?.activeSessionId;
  const end = command === "kill" || command === "abort"
    ? { type: command, activeSessionId: target?.activeSessionId }
    : { type: command, activeSessionId: sid, childId };
  show(`end command ${JSON.stringify(end)}`, await d.req(end));
  await delay(1500);
  show("roster after end", await roster());
  const before = requests(s).length;
  const send = kind === "child"
    ? "import agent_message\ntry:\n    r = await agent_message.send('SAY<<<woken>>>', receiver_role='child', receiver_name='w1')\n    print('SEND OK', r)\nexcept Exception as e:\n    print('SEND FAILED', type(e).__name__, e)"
    : "import agent_message\ntry:\n    r = await agent_message.send('SAY<<<woken>>>', receiver_role='sibling', receiver_name='s1')\n    print('SEND OK', r)\nexcept Exception as e:\n    print('SEND FAILED', type(e).__name__, e)";
  show("turn 2 (send)", (await turn(d, sid, `BEGINCMD\n${send}\nimport asyncio\nawait asyncio.sleep(4)\nENDCMD`)).prompt);
  await delay(1500);
  show("roster after send", await roster());
  show("model requests after the send that carry 'woken'", requests(s).slice(before).filter((r) => r.lastUserText.includes("woken")).length);
  show("parent tool results", toolResults(created.data.sessionFile));
  const types = d.events.map((e) => (e.type === "session_event" ? `session_event:${e.event?.type}` : e.type));
  show("event types (count)", types.reduce((acc, t) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {}));
  show("rlm_child_update events", d.events.filter((e) => e.event?.type === "rlm_child_update").map((e) => ({ status: e.event.child?.status, id: e.event.child?.activeSessionId, depth: e.event.child?.rlmDepth })));
  show("roster events", d.events.filter((e) => /roster/.test(e.type)).slice(0, 12).map((e) => JSON.stringify(e).slice(0, 400)));
} finally {
  await d.stop();
  fake.stop();
}
