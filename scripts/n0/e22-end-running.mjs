// N0 e22: end a session while it is mid-turn (the fake model holds its reply for 20 s):
// delete_rlm_subagent on a running depth-1 child, kill on a running depth-0 create_session session. Then try to wake each.
import { createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake, turn } from "./harness.mjs";
import { toolResults } from "./session-file.mjs";

const s = scratch("e22");
const fake = await startFake(s);
seedAgentDir(s, fake);
const d = await startDaemon(s);
const roster = async () => (await d.req({ type: "list" })).data.sessions.map((r) => ({ id: r.activeSessionId, sessionId: r.sessionId, depth: r.rlmDepth, name: r.sessionName ?? null, activity: r.activity, workerPid: r.workerPid }));
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  const sid = created.data.activeSessionId;
  await turn(d, sid, "BEGINCMD\nh = await rlm.spawn('SLEEP<<<20>>>', name='w1')\nh2 = await rlm.create_session('SLEEP<<<20>>>', name='s1')\nprint('OK', h.rlm_child_id, h2.active_session_id)\nENDCMD");
  await delay(1500);
  const rows = (await d.req({ type: "list" })).data.sessions;
  show("roster while both are mid-turn", await roster());
  const child = rows.find((r) => r.rlmDepth === 1);
  const session = rows.find((r) => r.rlmDepth === 0 && r.activeSessionId !== sid);
  show("delete_rlm_subagent on the running child", await d.req({ type: "delete_rlm_subagent", activeSessionId: sid, childId: child.rlmChildId }));
  show("kill on the running depth-0 session", await d.req({ type: "kill", activeSessionId: session.activeSessionId }));
  await delay(1500);
  show("roster after both end commands", await roster());
  const r0 = requests(s).length;
  await turn(d, sid, "BEGINCMD\nimport agent_message\nfor role, name in (('child', 'w1'), ('sibling', 's1')):\n    try:\n        r = await agent_message.send('SAY<<<woken>>>', receiver_role=role, receiver_name=name)\n        print('SEND OK', name, r['deliveryStatus'])\n    except Exception as e:\n        print('SEND FAILED', name, e)\nENDCMD");
  await delay(3000);
  show("send results", toolResults(created.data.sessionFile).slice(-1));
  show("roster after the sends", await roster());
  show("requests from woken sessions", requests(s).slice(r0).filter((r) => r.lastUserText.includes("[agent-message")).length);
} finally {
  await d.stop();
  fake.stop();
}
