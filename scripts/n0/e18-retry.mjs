// N0 e18: retry settings names, by behaviour. Each probe: one prompt against a fake 429 (retry-after 1 s); count provider requests.
// Usage: PROBES='[["label", {settings}], ...]' FAKE_RETRY_AFTER=1 node e18-retry.mjs
import fs from "node:fs";
import { createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const out = {};
for (const [label, settings] of JSON.parse(process.env.PROBES ?? "[]")) {
  const s = scratch("e18");
  const fake = await startFake(s);
  seedAgentDir(s, fake, { settings });
  const d = await startDaemon(s);
  try {
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
    const sid = created.data.activeSessionId;
    await d.req({ type: "attach", activeSessionId: sid });
    fs.writeFileSync(s.statusFile, "429");
    const t0 = Date.now();
    const r = await Promise.race([d.req({ type: "prompt_and_wait", activeSessionId: sid, message: "SAY<<<x>>>", queueIfBusy: false }, null), delay(60_000).then(() => null)]);
    const retries = d.events.filter((e) => e.event?.type === "auto_retry_start").map((e) => `${e.event.attempt}/${e.event.maxAttempts} ${e.event.delayMs}ms`);
    out[label] = { requests: requests(s).length, retries, seconds: (Date.now() - t0) / 1000, result: r ? (r.success ? "ok" : r.error.slice(0, 80)) : "pending at 60 s" };
  } finally { await d.stop(); fake.stop(); }
}
show("results", out);
