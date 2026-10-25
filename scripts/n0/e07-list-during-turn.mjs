// N0 e07: can `list` run on the same client while prompt_and_wait or wait_for_headless_completion is pending?
// The parent spawns a child that sleeps 8 s and ends its own turn without collecting, so the headless wait has something to wait for.
import { createConfig, delay, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const s = scratch("e07");
const fake = await startFake(s);
seedAgentDir(s, fake);
const d = await startDaemon(s);
try {
  // N0_AUTONOMOUS=1: autonomous mode with a 4 s gate, so wait_for_headless_completion stays pending.
const autonomous = process.env.N0_AUTONOMOUS ? { autonomous: { enabled: true, maxTurns: 3, maxContinuations: 1, gates: { commands: ["sleep 4"], maxRetries: 1 } } } : {};
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s, autonomous) }, 60_000);
  const sid = created.data.activeSessionId;
  const t0 = Date.now();
  const log = [];
  let phase = "prompt_and_wait";
  let stop = false;
  const poller = (async () => {
    while (!stop) {
      const at = Date.now();
      const r = await d.req({ type: "list" }, 10_000).catch((e) => ({ success: false, error: e.message }));
      log.push({ phase, sentMs: at - t0, answeredInMs: Date.now() - at, ok: r.success, sessions: r.data?.sessions?.map((x) => `${x.rlmDepth}:${x.activity}`).join(",") ?? r.error });
      await delay(500);
    }
  })();
  const p = await d.req({ type: "prompt_and_wait", activeSessionId: sid, queueIfBusy: false,
    message: "BEGINCMD\nh = await rlm.spawn('SLEEP<<<8>>>', name='sleeper')\nimport asyncio\nawait asyncio.sleep(3)\nprint('spawned', h)\nENDCMD" }, 120_000);
  show("prompt_and_wait returned after ms", { ms: Date.now() - t0, success: p.success, error: p.error ?? null });
  phase = "wait_for_headless_completion";
  const h = await d.req({ type: "wait_for_headless_completion", activeSessionId: sid }, 120_000);
  show("wait_for_headless_completion returned after ms", { ms: Date.now() - t0, success: h.success });
  phase = "after";
  await delay(9000);
  stop = true;
  await poller;
  show("list calls", log);
} finally {
  await d.stop();
  fake.stop();
}
