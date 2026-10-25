// N0 e06: after a daemon restart, does a resumed parent's old child (rlm.spawn) or old sibling session (rlm.create_session)
// appear in the fresh daemon's roster, and can the parent wake it with agent_message.send?
import { createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake, turn } from "./harness.mjs";
import { toolResults } from "./session-file.mjs";

const s = scratch("e06");
const fake = await startFake(s);
seedAgentDir(s, fake);
const brief = (row) => ({ activeSessionId: row.activeSessionId, sessionId: row.sessionId, rlmDepth: row.rlmDepth, runtimeKind: row.runtimeKind, name: row.sessionName ?? null,
  lifecycle: row.lifecycle, activity: row.activity, parentActiveSessionId: row.parentActiveSessionId ?? null, rlmChildId: row.rlmChildId ?? null });
let parentFile;
{
  const d = await startDaemon(s);
  try {
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
    parentFile = created.data.sessionFile;
    await turn(d, created.data.activeSessionId, "BEGINCMD\nh = await rlm.spawn('SAY<<<child-reply>>>', name='w1')\nr = await rlm.collect(h, timeout_ms=30000)\nprint('COLLECT', r)\nh2 = await rlm.create_session('SAY<<<session-reply>>>', name='s1')\nprint('SESSION', h2)\nimport asyncio\nawait asyncio.sleep(3)\nENDCMD");
    show("daemon 1 roster", (await d.req({ type: "list" })).data.sessions.map(brief));
  } finally {
    await d.stop();
  }
}
await delay(500);
{
  const d = await startDaemon(s);
  try {
    show("daemon 2 roster before create", (await d.req({ type: "list" })).data.sessions.map(brief));
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s), sessionPath: parentFile }, 60_000);
    const sid = created.data.activeSessionId;
    show("daemon 2 create (resume)", { success: created.success, error: created.error ?? null, activeSessionId: sid, sessionFile: created.data?.sessionFile });
    show("daemon 2 roster after resume, before prompt (baseline)", (await d.req({ type: "list" })).data.sessions.map(brief));
    const before = requests(s).length;
    await turn(d, sid, "BEGINCMD\nprint('SUBAGENTS', await rlm.list_subagents())\nimport agent_message\nfor role, name in (('child', 'w1'), ('sibling', 's1')):\n    try:\n        r = await agent_message.send('SAY<<<woken-' + name + '>>>', receiver_role=role, receiver_name=name)\n        print('SEND OK', name, r['deliveryStatus'], r['target'])\n    except Exception as e:\n        print('SEND FAILED', name, type(e).__name__, e)\nimport asyncio\nawait asyncio.sleep(4)\nENDCMD");
    await delay(1000);
    show("daemon 2 roster after send", (await d.req({ type: "list" })).data.sessions.map(brief));
    show("woken requests", requests(s).slice(before).filter((r) => /woken-(w1|s1)/.test(r.lastUserText) && !r.lastUserText.includes("BEGINCMD")).map((r) => r.lastUserText.slice(0, 120)));
    show("parent tool results (daemon 2)", toolResults(parentFile).slice(-1));
  } finally {
    await d.stop();
    fake.stop();
  }
}
