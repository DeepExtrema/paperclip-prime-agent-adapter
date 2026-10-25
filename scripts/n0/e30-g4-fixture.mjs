// N0 e30 (TAI-273 plan §4.4, G4): record the parent session's event stream from a real 0.10.1 daemon run with a child,
// a provider retry and a compaction, as the adapter writes it to the run log. The output is the G4 parser fixture.
// Usage (offline): scripts/n0/offline.sh node scripts/n0/e30-g4-fixture.mjs <output.jsonl>
import fs from "node:fs";
import { createConfig, delay, scratch, seedAgentDir, startDaemon, startFake } from "./harness.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: e30-g4-fixture.mjs <output.jsonl>");
process.env.FAKE_RETRY_AFTER = "1";
const s = scratch("e30-g4");
const fake = await startFake(s);
seedAgentDir(s, fake);
const d = await startDaemon(s);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  const sid = created.data.activeSessionId;
  await d.req({ type: "attach", activeSessionId: sid });
  const ask = (message) => d.req({ type: "prompt_and_wait", activeSessionId: sid, message, queueIfBusy: false }, 120_000);
  // 1. A depth-1 child that answers, collected by the parent.
  const spawn = "h = await rlm.spawn('SAY<<<child-answer>>>', name='w1')\nr = await rlm.collect(h, timeout_ms=30000)\nprint('COLLECT', r)";
  console.log("child turn", JSON.stringify(await ask(`BEGINCMD\n${spawn}\nENDCMD`)));
  await delay(1000);
  // 2. One 429 (retry-after 1 s), then the fake answers again: auto_retry_start, then auto_retry_end with success.
  fs.writeFileSync(s.statusFile, "429");
  const retried = ask("SAY<<<after-retry>>>");
  await delay(600);
  fs.rmSync(s.statusFile, { force: true });
  console.log("retry turn", JSON.stringify(await retried));
  // 3. A compaction from the daemon command.
  console.log("compact", JSON.stringify(await d.req({ type: "compact", activeSessionId: sid }, 120_000)));
  await delay(1000);
} finally {
  await d.stop();
  fake.stop();
}
const lines = [JSON.stringify({ type: "session", version: 3, id: "fixture-session", timestamp: "2026-10-25T00:00:00.000Z", cwd: "/workspace", model: "anthropic/claude-opus-5-5" })];
for (const message of d.events) {
  if (message.type === "session_event" && message.event && typeof message.event === "object") lines.push(JSON.stringify(message.event));
}
// Paths and ids of this scratch run are replaced, so the fixture holds no host path.
const text = `${lines.join("\n")}\n`.replaceAll(s.dir, "/scratch");
fs.writeFileSync(out, text);
const types = {};
for (const line of lines) { const t = JSON.parse(line).type; types[t] = (types[t] ?? 0) + 1; }
console.log(JSON.stringify(types, null, 2));
