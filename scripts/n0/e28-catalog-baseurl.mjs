// N0 addendum B (e28): does a model catalog entry's baseUrl redirect a provider's requests?
// No models.json. The agent dir's model catalog cache (<agentDir>/models/provider-model-catalog.v1.json) holds the
// public catalog (CATALOG=<path to a read-only copy of catalog.v1.json>), with anthropic/claude-opus-5-5's baseUrl
// pointed at the fake server. The fetch from GitHub fails offline, so only the cache can be read.
// Arg "https://…": point it at that URL instead (offline, so only the catalog read can be seen).
// Arg "rename": change only the entry's name, to show that an edited entry is kept unless its baseUrl changes.
// Arg "control": the same, but with the catalog's own baseUrl kept, so a request reaching the fake means nothing.
import fs from "node:fs";
import path from "node:path";
import { createConfig, FAKE_API_KEY, requests, scratch, show, startDaemon, startFake, tree, turn } from "./harness.mjs";

const control = process.argv[2] === "control";
const target = process.argv[2]?.startsWith("https://") ? process.argv[2] : null;
const rename = process.argv[2] === "rename";
const s = scratch(control ? "e28-control" : "e28");
const fake = await startFake(s);
const catalog = JSON.parse(fs.readFileSync(process.env.CATALOG, "utf8"));
let edited = 0;
for (const m of catalog.models) {
  if (m.provider === "anthropic" && m.id === "claude-opus-5-5" && !control) {
    if (rename) m.name = "Claude Opus 5.5 (n0 edit)";
    else m.baseUrl = target ?? fake.url;
    edited++;
  }
}
fs.mkdirSync(path.join(s.agentDir, "models"), { recursive: true });
fs.writeFileSync(path.join(s.agentDir, "models", "provider-model-catalog.v1.json"), JSON.stringify({
  url: "https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/main/models/catalog.v1.json",
  scope: "public", fetchedAt: Date.now(), etag: "W/\"n0-e28\"", payload: catalog,
}));
fs.writeFileSync(path.join(s.agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: FAKE_API_KEY } }), { mode: 0o600 });
fs.writeFileSync(path.join(s.agentDir, "settings.json"), "{}", { mode: 0o600 });
show("edited entries", edited);
const d = await startDaemon(s);
try {
  const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  show("create", { success: created.success, error: created.error });
  const sid = created.data?.activeSessionId;
  const gm = await d.req({ type: "get_model", activeSessionId: sid });
  show("get_model", gm);
  const cat = await d.req({ type: "get_model_catalog", activeSessionId: sid });
  const flat = JSON.stringify(cat);
  show("get_model_catalog", { success: cat.success, error: cat.error, bytes: flat.length, keys: Object.keys(cat.data ?? {}),
    opus55: (cat.data?.models ?? []).filter((m) => m.id === "claude-opus-5-5"), providers: cat.data?.configuredProviders, hasFakeUrl: flat.includes(fake.url), hasTarget: target ? flat.includes(target) : null });
  const t = sid ? await turn(d, sid, "SAY<<<catalog base url>>>", 60_000) : null;
  show("turn", { prompt: { success: t?.prompt?.success, error: t?.prompt?.error } });
  show("requests at the fake", requests(s).map((r) => ({ path: r.path, model: r.model, auth: r.auth })));
  show("catalog cache after", JSON.parse(fs.readFileSync(path.join(s.agentDir, "models", "provider-model-catalog.v1.json"), "utf8")).etag);
  show("agent dir", tree(s.agentDir).filter((p) => !p.startsWith("session")).slice(0, 40));
  show("scratch", s.dir);
} finally {
  await d.stop();
  fake.stop();
}
