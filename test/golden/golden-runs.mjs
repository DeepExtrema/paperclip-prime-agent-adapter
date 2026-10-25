// TAI-273 plan rev 7 §5 step 2, rule: with credentialMode unchanged and featureProfile and maxSubagentsPerRun absent, behaviour
// equals 1f8f816 except for section 7 item 9. This runs one execute() (old dist or current source) over fixed configs with
// allowedModels unset, and returns what the rule covers: the child env, the settings.json writes and the result keys.
// Record the 1f8f816 side with: node test/golden/record.mjs <1f8f816 checkout>/dist/server/execute.js test/fixtures/golden-1f8f816.json
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_DAEMON = path.join(here, "..", "fake-prime-daemon.mjs");
const FAKE_PRINT = path.join(here, "..", "fake-prime-agent.mjs");
const fixture = (name) => path.join(here, "..", "fixtures", name);

/** Env keys whose values differ per run for reasons outside the rule (sockets, temp dirs of the daemon). */
const VOLATILE = new Set(["PRIME_AGENT_DAEMON_SOCKET"]);
const SHARED_ENV = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-GOLDEN-not-real", ANTHROPIC_BASE_URL: "http://127.0.0.1:9/golden", OPERATOR_SETTING: "kept" };

export const GOLDEN_CONFIGS = {
  "print-host_auth": { config: { command: FAKE_PRINT }, env: { FAKE_PRIME_STDOUT_FILE: fixture("prime-jsonl/run2.jsonl") } },
  "print-api_key": { config: { command: FAKE_PRINT, credentialMode: "api_key", apiKeyEnvVar: "ANTHROPIC_API_KEY" },
    env: { FAKE_PRIME_STDOUT_FILE: fixture("prime-jsonl/run2.jsonl"), ANTHROPIC_API_KEY: "sk-ant-api03-GOLDEN-not-real" } },
  "daemon-host_auth-subagent": { config: { runtime: "daemon", command: FAKE_DAEMON, subagentDefaultModel: "anthropic/claude-haiku-4-5", rlmMaxDepth: 1 },
    env: { FAKE_DAEMON_EVENTS_FILE: fixture("prime-jsonl/run2.jsonl") } },
  "daemon-api_key-settings": { config: { runtime: "daemon", command: FAKE_DAEMON, credentialMode: "api_key", apiKeyEnvVar: "ANTHROPIC_API_KEY" },
    env: { FAKE_DAEMON_EVENTS_FILE: fixture("prime-jsonl/run2.jsonl"), ANTHROPIC_API_KEY: "sk-ant-api03-GOLDEN-not-real" },
    settings: { theme: "dark", shellPath: "/bin/sh", defaultThinkingLevel: "low" } },
};

const BASE_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
const TEST_DIR = path.join(here, "..");
const normalize = (value, root) => JSON.parse(JSON.stringify(value).replaceAll(root, "<root>").replaceAll(BASE_PATH, "<path>").replaceAll(TEST_DIR, "<test>"));

export async function goldenRuns(execute) {
  const out = {};
  const saved = { ...process.env };
  for (const [name, spec] of Object.entries(GOLDEN_CONFIGS)) {
    const root = mkdtempSync(path.join(os.tmpdir(), "prime-golden-"));
    try {
      for (const dir of ["home", "ws", "agents"]) mkdirSync(path.join(root, dir));
      // A fixed base env, so the record does not depend on the recording host's own variables.
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, { PATH: BASE_PATH, USER: "golden", LOGNAME: "golden", LANG: "C.UTF-8", SHELL: "/bin/sh",
        HOME: path.join(root, "home"), PAPERCLIP_HOME: path.join(root, "paperclip-home") });
      writeFileSync(path.join(root, "host-auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 0 } }), { mode: 0o600 });
      const agentDir = path.join(root, "agents", "agent-1", "prime-agent-home");
      if (spec.settings) {
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(spec.settings), { mode: 0o600 });
      }
      const record = path.join(root, "record.jsonl");
      const result = await execute({
        runId: "run-golden",
        agent: { id: "agent-1", companyId: "company-1", name: "Golden", adapterType: "prime_agent_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          model: "anthropic/claude-haiku-4-5", hostAuthFile: path.join(root, "host-auth.json"), agentDirRoot: path.join(root, "agents"),
          paperclipRuntimeSkills: [], ...spec.config,
          env: { FAKE_PRIME_RECORD: record, FAKE_DAEMON_RECORD: record, FAKE_PRIME_MODEL_LIST: fixture("model-list.txt"), ...SHARED_ENV, ...spec.env },
        },
        context: { paperclipWorkspace: { cwd: path.join(root, "ws"), source: "project_primary" }, taskId: "task-1" },
        authToken: "run-jwt-golden",
        onLog: async () => undefined,
      });
      const lines = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
      const start = lines.find((line) => line.kind === "start" || line.argv?.[0] === "--mode");
      const env = Object.fromEntries(Object.entries(start?.env ?? {}).filter(([key]) => !VOLATILE.has(key)).sort(([a], [b]) => a.localeCompare(b)));
      const settingsFile = path.join(agentDir, "settings.json");
      out[name] = normalize({
        env,
        settings: existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : null,
        resultKeys: Object.keys(result).sort(),
        resultJsonKeys: Object.keys(result.resultJson ?? {}).sort(),
        errorCode: result.errorCode ?? null,
        clearSession: result.clearSession ?? null,
        billingType: result.billingType ?? null,
      }, root);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    }
  }
  return out;
}
