// N0 e15: settings that Prime's own CLI writes, to read field names from Prime's serializer.
import fs from "node:fs";
import path from "node:path";
import { runPrime, scratch, show } from "./harness.mjs";

const s = scratch("e15");
fs.writeFileSync(path.join(s.agentDir, "settings.json"), "{}");
for (const args of [["telemetry"], ["telemetry", "off"], ["telemetry"], ["telemetry", "on"]]) {
  const r = await runPrime(s, args, { timeoutMs: 20_000 });
  show(`prime-agent ${args.join(" ")}`, { code: r.code, out: (r.stdout + r.stderr).trim().slice(0, 600), settings: fs.readFileSync(path.join(s.agentDir, "settings.json"), "utf8") });
}
