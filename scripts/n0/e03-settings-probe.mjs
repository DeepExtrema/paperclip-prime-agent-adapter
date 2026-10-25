// N0 e03: which settings.json keys does 0.10.1 parse? Run print mode against the fake server with a bad-typed value and look for a diagnostic.
import fs from "node:fs";
import path from "node:path";
import { runPrime, scratch, seedAgentDir, show, startFake } from "./harness.mjs";

const s = scratch("e03");
const fake = await startFake(s);
seedAgentDir(s, fake);
const probe = async (settings) => {
  fs.writeFileSync(path.join(s.agentDir, "settings.json"), JSON.stringify(settings));
  const r = await runPrime(s, ["--mode", "json", "-p", "--provider", "anthropic", "--model", "claude-opus-5-5", "--offline", "--", "SAY<<<x>>>"], { timeoutMs: 60_000 });
  const lines = (r.stdout + "\n" + r.stderr).split("\n").filter((l) => l.trim() && !l.startsWith('{"type":"message_update"'));
  return { code: r.code, stderr: r.stderr.slice(0, 600), nonJson: lines.filter((l) => !l.startsWith("{")).slice(0, 5), settingsAfter: fs.readFileSync(path.join(s.agentDir, "settings.json"), "utf8").slice(0, 300) };
};
for (const [label, settings] of JSON.parse(process.env.PROBES ?? "[]")) show(label, await probe(settings));
fake.stop();
