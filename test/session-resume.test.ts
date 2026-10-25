// TAI-273 plan rev 7 §4.3 (G3): issue-scoped session resume in daemon mode.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../src/server/execute.js";

const FAKE = fileURLToPath(new URL("./fake-prime-daemon.mjs", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const MODEL = "anthropic/claude-haiku-4-5";
const savedEnv = { ...process.env };
let root = "";
type Rec = { kind: string; workerPid?: number; pid?: number; command?: Record<string, unknown> & { type: string } };
const rec = () => path.join(root, "daemon.jsonl");
const records = (): Rec[] => (existsSync(rec()) ? readFileSync(rec(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Rec) : []);
const creates = () => records().filter((r) => r.kind === "command" && r.command!.type === "create").map((r) => r.command!);
const ENFORCED = { credentialMode: "api_key", apiKeyEnvVar: "ANTHROPIC_API_KEY", allowedModels: [MODEL] };
type Over = { config?: Record<string, unknown>; env?: Record<string, string>; sessionParams?: Record<string, unknown> | null; runId?: string };
async function run(over: Over = {}) {
  const logs: string[] = [];
  const ctx: AdapterExecutionContext = {
    runId: over.runId ?? "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Prime Tester", adapterType: "prime_agent_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: over.sessionParams ?? null, sessionDisplayId: null, taskKey: null },
    config: {
      runtime: "daemon", command: FAKE, model: MODEL, agentDirRoot: path.join(root, "agents"), paperclipRuntimeSkills: [], ...ENFORCED,
      env: { FAKE_DAEMON_RECORD: rec(), FAKE_DAEMON_EVENTS_FILE: fixture("prime-jsonl/run2.jsonl"), FAKE_PRIME_MODEL_LIST: fixture("model-list.txt"),
        ANTHROPIC_API_KEY: "sk-ant-api03-FIXTURE-g3", ...over.env },
      ...over.config,
    },
    context: { paperclipWorkspace: { cwd: path.join(root, "ws"), source: "project_primary" }, taskId: "task-1" },
    authToken: "run-jwt-token",
    onLog: async (_stream, chunk) => void logs.push(chunk),
  };
  return { result: await execute(ctx), log: () => logs.join("") };
}
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "prime-g3-"));
  for (const dir of ["home", "ws", "agents"]) mkdirSync(path.join(root, dir));
  process.env.HOME = path.join(root, "home");
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
});
afterEach(() => {
  for (const { workerPid } of records()) if (workerPid) try { process.kill(workerPid, "SIGKILL"); } catch { /* gone */ }
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

describe("item 1: a missing or unknown session file starts one fresh session", () => {
  it("retries create once without sessionPath and returns the new session without clearSession", async () => {
    const first = await run();
    const params = first.result.sessionParams!;
    const second = await run({ runId: "run-2", sessionParams: params, env: { FAKE_DAEMON_CREATE_ERROR: `No session file found at ${String(params.sessionFile)}` } });
    expect(creates().slice(1).map((c) => Boolean(c.sessionPath))).toEqual([true, false]);
    expect(second.result).toMatchObject({ exitCode: 0, errorCode: null, clearSession: false });
    expect(second.result.sessionId).not.toBe(first.result.sessionId);
    expect(second.log()).toContain(`[paperclip] Prime session ${String(params.sessionId)} is unavailable (No session file found at`);
  });
});

describe("item 2: a held lease fails the run and keeps the row", () => {
  it("gives prime_session_busy, no retry, no session fields and no clearSession", async () => {
    const first = await run();
    const params = first.result.sessionParams!;
    const second = await run({ runId: "run-2", sessionParams: params,
      env: { FAKE_DAEMON_CREATE_ERROR: `Session ${String(params.sessionId)} is currently open in another Prime Agent process (pid 4242).` } });
    expect(creates().slice(1)).toHaveLength(1);
    expect(second.result).toMatchObject({ errorCode: "prime_session_busy", clearSession: false, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    expect(second.result.sessionParams).toBeUndefined();
    expect(second.log()).toContain(`[paperclip] Prime session ${String(params.sessionId)} is held by another process (pid 4242); not starting.`);
  });
});

describe("item 3: never resume a failed policy run", () => {
  it.each([
    ["prime_settings_tampered", { FAKE_DAEMON_EDIT_SETTINGS: JSON.stringify({ allowedModels: ["openai-codex/gpt-6-astra"] }) }],
    ["prime_auth_tampered", { FAKE_DAEMON_EDIT_AUTH: JSON.stringify({ openai: { type: "api_key", key: "x" } }) }],
    ["prime_model_audit_failed", { FAKE_DAEMON_AUDIT_CHILD: JSON.stringify([{ role: "assistant", provider: "openai-codex", model: "gpt-6-astra", content: [] }]) }],
  ])("%s returns clearSession: true and no session params", async (code, env) => {
    const { result } = await run({ env });
    expect(result).toMatchObject({ errorCode: code, clearSession: true });
    expect(result.sessionParams).toBeUndefined();
  });
  it("other failures never clear the session", async () => {
    for (const env of [{ FAKE_DAEMON_PROMPT_MODE: "error" } as Record<string, string>, { FAKE_DAEMON_PROMPT_MODE: "error", FAKE_DAEMON_PROMPT_DIAGNOSTIC: "auth" },
      { FAKE_DAEMON_PROMPT_MODE: "error", FAKE_DAEMON_PROMPT_DIAGNOSTIC: "rate_limit" }]) {
      expect((await run({ env })).result.clearSession).toBe(false);
    }
  });
});

describe("item 5: workers outlive no run", () => {
  it("signals the group of a worker that survives a clean daemon exit", async () => {
    const { result } = await run({ config: { graceSec: 0.3 }, env: { FAKE_DAEMON_WORKER: "1" } });
    expect(result.errorCode).toBeNull();
    const worker = records().find((r) => r.kind === "worker")!.workerPid!;
    await vi.waitFor(() => {
      const state = existsSync(`/proc/${worker}/stat`) ? readFileSync(`/proc/${worker}/stat`, "utf8").split(") ")[1]![0] : null;
      expect(state === null || state === "Z").toBe(true);
    });
  });
});
