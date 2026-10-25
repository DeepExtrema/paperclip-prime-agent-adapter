// N0 e23: ending a running depth-1 child in two steps. Usage: node e23-end-running-child.mjs <abort|cancel_rlm_child|kill>
// Step 1 stops the child's turn; step 2 is delete_rlm_subagent (retried until deleted); then the parent tries to wake it.
import { createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake, turn } from "./harness.mjs";
import { toolResults } from "./session-file.mjs";

const first = process.argv[2] ?? "abort";
const s = scratch(`e23-${first}`);
const fake = await startFake(s);
seedAgentDir(s, fake);
const d = await startDaemon(s);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  const sid = created.data.activeSessionId;
  await turn(d, sid, "BEGINCMD\nh = await rlm.spawn('SLEEP<<<20>>>', name='w1')\nprint('OK', h.rlm_child_id)\nENDCMD");
  await delay(1500);
  const child = (await d.req({ type: "list" })).data.sessions.find((r) => r.rlmDepth === 1);
  const step1 = first === "cancel_rlm_child" ? { type: first, activeSessionId: sid, childId: child.rlmChildId } : { type: first, activeSessionId: child.activeSessionId };
  const t0 = Date.now();
  show(`step 1 ${JSON.stringify(step1)}`, await d.req(step1));
  const attempts = [];
  for (let i = 0; i < 20; i += 1) {
    const r = await d.req({ type: "delete_rlm_subagent", activeSessionId: sid, childId: child.rlmChildId });
    attempts.push({ ms: Date.now() - t0, data: r.data ?? r.error });
    if (r.data?.deleted !== false) break;
    await delay(250);
  }
  show("step 2 delete_rlm_subagent attempts", attempts);
  show("roster", (await d.req({ type: "list" })).data.sessions.map((r) => ({ id: r.activeSessionId, depth: r.rlmDepth, activity: r.activity })));
  const r0 = requests(s).length;
  await turn(d, sid, "BEGINCMD\nimport agent_message\ntry:\n    r = await agent_message.send('SAY<<<woken>>>', receiver_role='child', receiver_name='w1')\n    print('SEND OK', r['deliveryStatus'])\nexcept Exception as e:\n    print('SEND FAILED', e)\nENDCMD");
  await delay(3000);
  show("send result", toolResults(created.data.sessionFile).slice(-1));
  show("requests from a woken child", requests(s).slice(r0).filter((r) => r.lastUserText.includes("[agent-message")).length);
} finally {
  await d.stop();
  fake.stop();
}
