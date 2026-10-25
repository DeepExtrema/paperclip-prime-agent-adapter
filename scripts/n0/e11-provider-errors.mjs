// N0 e11: the events and texts Prime 0.10.1 gives when the provider answers 401 or 429 (fake server, fake key).
// Usage: node e11-provider-errors.mjs <status> [settings JSON]
import fs from "node:fs";
import path from "node:path";
import { FAKE_OAT_KEY, createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const status = process.argv[2] ?? "401";
const settings = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const s = scratch(`e11-${status}`);
const fake = await startFake(s);
seedAgentDir(s, fake, { key: process.env.N0_KEY === "oat" ? FAKE_OAT_KEY : undefined, settings });
const d = await startDaemon(s);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  const sid = created.data.activeSessionId;
  await d.req({ type: "attach", activeSessionId: sid });
  fs.writeFileSync(s.statusFile, status);
  const t0 = Date.now();
  const pending = d.req({ type: "prompt_and_wait", activeSessionId: sid, message: "SAY<<<never answered>>>", queueIfBusy: false }, null);
  const result = await Promise.race([pending, delay(Number(process.env.N0_WAIT_MS ?? 90_000)).then(() => "still pending after wait")]);
  show("prompt_and_wait", { afterMs: Date.now() - t0, result });
  const rows = (await d.req({ type: "list" })).data.sessions;
  show("roster row flags", rows.map((r) => ({ activity: r.activity, isQuotaParked: r.isQuotaParked, isSessionActive: r.isSessionActive, isStreaming: r.isStreaming })));
  if (result === "still pending after wait") show("abort", await d.req({ type: "abort", activeSessionId: sid }));
  await delay(1000);
  show("provider requests", requests(s).map((r) => ({ at: r.at, status: r.status })));
  const events = d.events.filter((e) => e.type !== "roster_update").map((e) => (e.type === "session_event" ? e.event : e));
  show("event types", events.map((e) => e.type));
  show("non-streaming events (full)", events.filter((e) => !["message_update"].includes(e.type)).map((e) => JSON.stringify(e).slice(0, 900)));
  show("last assistant text", await d.req({ type: "get_last_assistant_text", activeSessionId: sid }));
} finally {
  await d.stop();
  fake.stop();
}
