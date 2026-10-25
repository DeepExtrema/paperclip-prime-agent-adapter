// N0 e01: daemon starts offline, the fake server answers, one turn completes; record the hello, the command list and the roster row.
import fs from "node:fs";
import { createConfig, requests, scratch, seedAgentDir, show, startDaemon, startFake, tree, turn } from "./harness.mjs";

const s = scratch("e01");
const fake = await startFake(s);
seedAgentDir(s, fake);
const d = await startDaemon(s);
try {
  show("hello", d.client.hello);
  show("unknown command", await d.req({ type: "n0_no_such_command" }));
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  show("create", created);
  const sid = created.data?.activeSessionId;
  show("turn", await turn(d, sid, "SAY<<<hello from n0>>>"));
  show("list", await d.req({ type: "list" }));
  show("last text", await d.req({ type: "get_last_assistant_text", activeSessionId: sid }));
  show("requests", requests(s).map((r) => ({ path: r.path, model: r.model, auth: r.auth, beta: r.beta, userAgent: r.userAgent, tools: r.tools, systemChars: r.system.length })));
  fs.writeFileSync(`${s.dir}/system-prompt.txt`, requests(s)[0]?.system ?? "");
  show("event types", [...new Set(d.events.map((e) => (e.type === "session_event" ? `session_event:${e.event?.type}` : e.type)))]);
  show("agent dir", tree(s.agentDir));
  show("home", tree(s.home).filter((p) => !p.includes("kernel-venv/")).slice(0, 80));
  show("scratch", s.dir);
} finally {
  await d.stop();
  fake.stop();
}
