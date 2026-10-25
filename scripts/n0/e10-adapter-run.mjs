// N0 e10: one real adapter run (this worktree's dist/, daemon runtime, api_key mode with a fake key) against Prime 0.10.1 and the fake server.
// Records the settings.json keys Prime itself writes during a normal daemon run, and what the agent dir holds afterwards.
// Usage: node e10-adapter-run.mjs [extra adapterConfig JSON]
import fs from "node:fs";
import path from "node:path";
import { FAKE_API_KEY, FAKE_OAT_KEY, PRIME, requests, scratch, show, startFake, tree } from "./harness.mjs";

const s = scratch("e10");
process.env.HOME = s.home;
process.env.PAPERCLIP_HOME = path.join(s.dir, "paperclip-home");
const { execute } = await import("../../dist/server/execute.js");
const fake = await startFake(s);
const agentDirRoot = path.join(s.dir, "agents");
const agentDir = path.join(agentDirRoot, "agent-1", "prime-agent-home");
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
// The catalog fetch is offline here, so models.json declares Opus 5.5 as a reasoning model, as the live catalog does.
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: fake.url,
  models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000 }] } } }));
const kernel = process.env.N0_KERNEL;
const extra = process.argv[2] ? JSON.parse(process.argv[2]) : {};
const runOnce = async (runId, sessionParams, prompt) => {
  const logs = [];
  const ctx = {
    runId, agent: { id: "agent-1", companyId: "company-1", name: "N0", adapterType: "prime_agent_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams, sessionDisplayId: null, taskKey: null },
    config: {
      runtime: "daemon", command: PRIME, model: "anthropic/claude-opus-5-5", thinking: "high", credentialMode: "api_key", apiKeyEnvVar: "ANTHROPIC_API_KEY",
      allowedModels: ["anthropic/claude-opus-5-5"], subagentDefaultModel: "anthropic/claude-opus-5-5", rlmMaxDepth: 1, timeoutSec: 300, agentDirRoot,
      env: { ANTHROPIC_API_KEY: process.env.N0_KEY === "oat" ? FAKE_OAT_KEY : FAKE_API_KEY, PRIME_AGENT_ALLOW_HTTP: "1",
        ...(kernel ? { PRIME_AGENT_KERNEL_VENV: path.join(kernel, "venv"), UV_PYTHON_INSTALL_DIR: path.join(kernel, "python"), UV_CACHE_DIR: path.join(kernel, "uv-cache"), UV_OFFLINE: "1" } : {}) },
      ...extra,
    },
    context: { paperclipWorkspace: { cwd: s.work, source: "project_primary" }, taskId: "task-1", paperclipTaskMarkdown: `## Task\n${prompt}` },
    authToken: "run-jwt-token",
    onLog: async (_stream, chunk) => void logs.push(chunk),
    onSpawn: async () => undefined,
  };
  const result = await execute(ctx);
  return { result, logs };
};
const settingsFile = path.join(agentDir, "settings.json");
const first = await runOnce("run-1", null, "SAY<<<adapter run one>>>");
show("run 1 result", { exitCode: first.result.exitCode, errorCode: first.result.errorCode ?? null, errorMessage: first.result.errorMessage ?? null,
  sessionParams: first.result.sessionParams ?? null, clearSession: first.result.clearSession, modelAuditOk: first.result.resultJson?.modelAudit?.ok, settings: first.result.resultJson?.settings });
show("settings.json after run 1", fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : null);
const second = await runOnce("run-2", first.result.sessionParams ?? null, "SAY<<<adapter run two>>>");
show("run 2 result", { exitCode: second.result.exitCode, errorCode: second.result.errorCode ?? null, errorMessage: second.result.errorMessage ?? null,
  sessionId: second.result.sessionId ?? null, resumedSame: second.result.sessionId === first.result.sessionId });
show("settings.json after run 2", fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : null);
show("agent dir top level after both runs", fs.readdirSync(agentDir).sort());
show("agent dir tree (no logs/daemon-workers)", tree(agentDir).filter((p) => !p.startsWith("logs/") && !p.startsWith("daemon-workers/")));
show("model requests", requests(s).map((r) => ({ model: r.model, auth: r.auth, lastUserText: r.lastUserText.slice(-60) })));
show("adapter log lines starting with [paperclip]", [...first.logs, ...second.logs].filter((l) => l.startsWith("[paperclip]")));
fake.stop();
show("scratch", s.dir);
