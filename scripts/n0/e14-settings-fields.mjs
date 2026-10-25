// N0 e14: settings field names by a parse oracle. settings.json holds rlmMaxDepth 3 plus one probe value.
// If get_rlm_max_depth_status still reports 3 ("global"), the file parsed: the probe path is unknown or its value is valid.
// If it reports the default (2), the file failed to parse: the probe path exists and the value has the wrong type.
// Usage: PROBES='[["label", {...settings fragment...}], ...]' node e14-settings-fields.mjs
import { createConfig, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

const probes = JSON.parse(process.env.PROBES ?? "[]");
const s = scratch("e14");
const fake = await startFake(s);
const out = {};
for (const [label, fragment] of probes) {
  seedAgentDir(s, fake, { settings: { rlmMaxDepth: 3, ...fragment } });
  const d = await startDaemon(s);
  try {
    const created = await d.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
    const status = (await d.req({ type: "get_rlm_max_depth_status", activeSessionId: created.data.activeSessionId })).data;
    out[label] = status?.maxDepth === 3 ? "parsed" : `NOT parsed (${JSON.stringify(status)})`;
  } catch (err) {
    out[label] = `error ${err.message}`;
  } finally {
    await d.stop();
  }
}
fake.stop();
show("results", out);
