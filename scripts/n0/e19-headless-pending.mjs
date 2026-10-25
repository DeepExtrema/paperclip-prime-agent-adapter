// N0 e19: with an active goal, wait_for_headless_completion stays pending; can `list` run on the same client meanwhile?
// The fake server leaves goal continuations unanswered (s.goalHangFile), so the goal keeps the session busy.
import fs from "node:fs";
import { createConfig, delay, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const s = scratch("e19");
const fake = await startFake(s);
seedAgentDir(s, fake);
const d = await startDaemon(s);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  const sid = created.data.activeSessionId;
  fs.writeFileSync(s.goalHangFile, "1");
  await d.req({ type: "prompt_and_wait", activeSessionId: sid, queueIfBusy: false, message: "BEGINCMD\nprint(await goal.create('N0 pending objective'))\nENDCMD" }, 60_000);
  let settled = null;
  const t0 = Date.now();
  d.req({ type: "wait_for_headless_completion", activeSessionId: sid }, null).then((r) => (settled = { ms: Date.now() - t0, success: r.success })).catch((e) => (settled = { error: e.message }));
  const lists = [];
  for (let i = 0; i < 6; i += 1) {
    await delay(1000);
    const at = Date.now();
    const r = await d.req({ type: "list" }, 5000).catch((e) => ({ success: false, error: e.message }));
    lists.push({ atMs: at - t0, answeredInMs: Date.now() - at, ok: r.success, headlessSettled: settled !== null, parent: r.data?.sessions?.find((x) => x.activeSessionId === sid)?.activity });
  }
  show("list calls while wait_for_headless_completion is pending", lists);
  show("abort", (await d.req({ type: "abort", activeSessionId: sid })).success);
  await delay(2000);
  show("wait_for_headless_completion after abort", settled);
} finally {
  await d.stop();
  fake.stop();
}
