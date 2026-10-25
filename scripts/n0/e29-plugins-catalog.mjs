// N0 addendum B (e29): does a daemon session install or load anything from the plugins catalog?
// Arg "with": <agentDir>/mcp-service-catalog.v2.json holds the public plugins catalog (PLUGINS=<path to a read-only copy
// of plugins/catalog.v2.json>), as a fresh cache. Arg "without": no cache. Offline, so the GitHub fetch fails in both.
// Compare the first model request's tools and system prompt, and the files the run leaves in the agent dir.
import fs from "node:fs";
import path from "node:path";
import { createConfig, requests, scratch, seedAgentDir, show, startDaemon, startFake, tree, turn } from "./harness.mjs";

const withCache = process.argv[2] === "with";
const s = scratch(withCache ? "e29-with" : "e29-without");
const fake = await startFake(s);
seedAgentDir(s, fake);
if (withCache) {
  fs.writeFileSync(path.join(s.agentDir, "mcp-service-catalog.v2.json"), JSON.stringify({
    url: "https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/main/plugins/catalog.v2.json",
    scope: "public", fetchedAt: Date.now(), etag: "W/\"n0-e29\"", payload: JSON.parse(fs.readFileSync(process.env.PLUGINS, "utf8")),
  }));
}
const d = await startDaemon(s);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  const sid = created.data?.activeSessionId;
  const t = await turn(d, sid, "SAY<<<plugins catalog>>>", 60_000);
  show("turn", { success: t.prompt?.success, error: t.prompt?.error });
  const r = requests(s)[0];
  const system = r?.system ?? "";
  show("first request", { tools: r?.tools, systemChars: system.length, mentionsAirtable: /airtable/i.test(system), mentionsMcpUrl: /mcp\.[a-z]+\.(com|live|io)/i.test(system) });
  const snap = await d.req({ type: "get_resource_snapshot", activeSessionId: sid });
  show("snapshot keys", Object.keys(snap.data ?? {}));
  show("agent dir", tree(s.agentDir).filter((p) => !p.startsWith("session") && !p.startsWith("daemon-workers/") && !p.startsWith("logs/")));
  fs.writeFileSync(path.join(s.dir, "system-prompt.txt"), system);
  show("scratch", s.dir);
} finally {
  await d.stop();
  fake.stop();
}
