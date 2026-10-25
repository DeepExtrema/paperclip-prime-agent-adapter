// N0 e13b: does a project settings scalar win over the agent dir's? defaultThinkingLevel, read from the create response
// when the create config sets no thinking level.
import fs from "node:fs";
import path from "node:path";
import { createConfig, scratch, seedAgentDir, show, startDaemon, startFake } from "./harness.mjs";

async function probe(label, agentSettings, projectSettings) {
  const s = scratch("e13b");
  const fake = await startFake(s);
  seedAgentDir(s, fake, { settings: agentSettings, models: { providers: { anthropic: { baseUrl: fake.url, models: [{ id: "claude-opus-5-5", reasoning: true }] } } } });
  if (projectSettings) { fs.mkdirSync(path.join(s.work, ".prime", "agent"), { recursive: true }); fs.writeFileSync(path.join(s.work, ".prime", "agent", "settings.json"), JSON.stringify(projectSettings)); }
  const d = await startDaemon(s);
  try {
    const config = createConfig(s);
    delete config.thinking;
    const created = await d.req({ type: "create", lifecycle: "resident", config }, 60_000);
    show(label, { thinkingLevel: created.data?.thinkingLevel, error: created.error ?? null });
  } finally { await d.stop(); fake.stop(); }
}
await probe("none", {}, null);
await probe("agent low", { defaultThinkingLevel: "low" }, null);
await probe("project low only", {}, { defaultThinkingLevel: "low" });
await probe("agent medium, project low", { defaultThinkingLevel: "medium" }, { defaultThinkingLevel: "low" });
