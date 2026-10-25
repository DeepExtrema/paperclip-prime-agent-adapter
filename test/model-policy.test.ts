// TAI-225 rev 3 §9 acceptance (P0), plus Sentinel's TAI-228 findings 2 and 4. Fake daemon and fake print agent only; no quota.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../src/server/execute.js";
import { PRIME_MANAGED_SETTINGS_KEYS, resolvePrimeModelPolicy } from "../src/server/model-policy.js";

const FAKE = fileURLToPath(new URL("./fake-prime-daemon.mjs", import.meta.url));
const FAKE_PRINT = fileURLToPath(new URL("./fake-prime-agent.mjs", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const RUN2 = fixture("prime-jsonl/run2.jsonl");
const HAIKU = "anthropic/claude-haiku-4-5";
const OPUS = "anthropic/claude-opus-5-5";
const ASTRA = { provider: "openai-codex", model: "gpt-6-astra" };
const OAT_KEY = "sk-ant-oat01-fake-test-token";
const savedEnv = { ...process.env };
let root = "";
type Rec = { pid: number; workerPid?: number; kind: string; env?: Record<string, string>; command?: { type: string } };
const rec = () => path.join(root, "daemon.jsonl");
const records = (): Rec[] => (existsSync(rec()) ? readFileSync(rec(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Rec) : []);
const starts = () => records().filter((r) => r.kind === "start");
const types = () => records().filter((r) => r.kind === "command").map((r) => r.command!.type);
const agentDir = () => path.join(root, "agents", "agent-1", "prime-agent-home");
const settingsFile = () => path.join(agentDir(), "settings.json");
const authFile = () => path.join(agentDir(), "auth.json");
const readSettings = () => JSON.parse(readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const turn = (provider: string | undefined, model: string | undefined) => ({ role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "stop",
  ...(provider ? { provider } : {}), ...(model ? { model } : {}) });
const API_KEY = { credentialMode: "api_key", apiKeyEnvVar: "ANTHROPIC_API_KEY" };
const ENFORCED = { allowedModels: [HAIKU] };

type Over = { config?: Record<string, unknown>; env?: Record<string, string>; signal?: AbortSignal; runId?: string; sessionParams?: Record<string, unknown> };
async function run(over: Over = {}) {
  const notes: string[][] = [];
  const ctx: AdapterExecutionContext = {
    runId: over.runId ?? "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Prime Tester", adapterType: "prime_agent_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: over.sessionParams ?? null, sessionDisplayId: null, taskKey: null },
    config: {
      runtime: "daemon", command: FAKE, model: HAIKU, hostAuthFile: path.join(root, "host-auth.json"),
      agentDirRoot: path.join(root, "agents"), paperclipRuntimeSkills: [],
      env: { FAKE_DAEMON_RECORD: rec(), FAKE_DAEMON_EVENTS_FILE: RUN2, FAKE_PRIME_MODEL_LIST: fixture("model-list.txt"), FAKE_PRIME_STDOUT_FILE: RUN2, ...over.env },
      ...over.config,
    },
    context: { paperclipWorkspace: { cwd: path.join(root, "ws"), source: "project_primary" }, taskId: "task-1" },
    signal: over.signal, authToken: "run-jwt-token",
    onLog: async () => undefined,
    onMeta: async (meta) => void notes.push(meta.commandNotes ?? []),
  };
  const result = await execute(ctx);
  return { result, notes: notes.flat(), json: (result.resultJson ?? {}) as Record<string, any> };
}
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "prime-tai232-"));
  for (const dir of ["home", "ws", "agents"]) mkdirSync(path.join(root, dir));
  process.env.HOME = path.join(root, "home");
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
  writeFileSync(path.join(root, "host-auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 0 } }), { mode: 0o600 });
});
afterEach(() => {
  try {
    for (const { pid } of starts()) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("item 1: an unreadable settings.json fails the run and is never written", () => {
  it.each([
    ["daemon, allowedModels set", { ...ENFORCED }],
    ["daemon, allowedModels unset, subagentDefaultModel set (the old overwrite path)", { subagentDefaultModel: HAIKU }],
    ["print, allowedModels unset", { runtime: "print", command: FAKE_PRINT }],
  ])("%s", async (_name, config) => {
    mkdirSync(agentDir(), { recursive: true });
    for (const content of ["{ not json", "[1, 2]", "\"text\""]) {
      writeFileSync(settingsFile(), content);
      const before = sha(settingsFile());
      const { result } = await run({ config });
      expect(result).toMatchObject({ exitCode: 1, errorCode: "prime_settings_invalid" });
      expect(sha(settingsFile())).toBe(before);
    }
    expect(starts()).toEqual([]);
  });
});

describe("item 2: managed keys", () => {
  it("writes allowedModels and every model-valued key of 0.10.1, keeps other keys, records the sha256", async () => {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ theme: "dark", rlmMaxDepth: 2 }));
    const { result, json } = await run({ config: { ...ENFORCED } });
    expect(result).toMatchObject({ exitCode: 0, errorCode: null });
    expect(readSettings()).toEqual({ theme: "dark", rlmMaxDepth: 2, allowedModels: [HAIKU], enabledModels: [HAIKU], defaultProvider: "anthropic",
      defaultModel: "claude-haiku-4-5", subagentDefaultModel: HAIKU, auxiliaryModel: HAIKU, providerBackupModel: HAIKU, imageModel: HAIKU });
    expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
    expect(json.settings).toEqual({ file: settingsFile(), sha256Written: sha(settingsFile()), sha256After: sha(settingsFile()), restoredKeys: [], tamperedKeys: [] });
  });
  it("restores a managed key edited between runs and says so in the run notes", async () => {
    await run({ config: { ...ENFORCED } });
    writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), allowedModels: [HAIKU, `${ASTRA.provider}/${ASTRA.model}`], imageModel: "x/y" }));
    const { result, notes, json } = await run({ runId: "run-2", config: { ...ENFORCED } });
    expect(result.errorCode).toBeNull();
    expect(readSettings()).toMatchObject({ allowedModels: [HAIKU], imageModel: HAIKU });
    expect(json.settings.restoredKeys).toEqual(["allowedModels", "imageModel"]);
    expect(notes).toContain("settings.json: restored managed keys changed since the last run: allowedModels, imageModel.");
  });
  it("applies modelRoles and refuses a model or role outside allowedModels before Prime starts", async () => {
    await run({ config: { allowedModels: [HAIKU, OPUS], modelRoles: { auxiliaryModel: OPUS } } });
    expect(readSettings()).toMatchObject({ auxiliaryModel: OPUS, imageModel: HAIKU });
    for (const config of [{ allowedModels: [OPUS] }, { allowedModels: [HAIKU], subagentDefaultModel: OPUS }, { allowedModels: [HAIKU], modelRoles: { imageModel: OPUS } },
      { allowedModels: [] }, { allowedModels: ["haiku"] }, { allowedModels: [HAIKU], modelRoles: { notARole: HAIKU } }, { modelRoles: { imageModel: HAIKU } }]) {
      const { result } = await run({ runId: "run-x", config });
      expect(result, JSON.stringify(config)).toMatchObject({ exitCode: 1, errorCode: "prime_allowed_models_invalid" });
    }
    expect(starts()).toHaveLength(1);
  });
  it("lists every managed key", () => {
    expect(PRIME_MANAGED_SETTINGS_KEYS).toEqual(["allowedModels", "enabledModels", "defaultProvider", "defaultModel",
      "subagentDefaultModel", "auxiliaryModel", "providerBackupModel", "imageModel"]);
    expect(resolvePrimeModelPolicy({ allowedModels: `${HAIKU}\n${OPUS}` }, { modelRef: HAIKU, provider: "anthropic", model: "claude-haiku-4-5" },
      { runtime: "daemon", subagentDefaultModel: null }).allowedModels).toEqual([HAIKU, OPUS]);
  });
});

describe("item 3: settings check after the run", () => {
  it("fails a run whose agent edited a managed key, whatever the agent reported", async () => {
    const { result, json } = await run({ config: { ...ENFORCED }, env: { FAKE_DAEMON_EDIT_SETTINGS: JSON.stringify({ allowedModels: [HAIKU, "openai-codex/gpt-6-astra"] }) } });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "prime_settings_tampered", errorMeta: { runErrorCode: null } });
    expect(result.errorMessage).toContain("allowedModels");
    expect(result.sessionParams).toBeUndefined();
    expect(json.settings.tamperedKeys).toEqual(["allowedModels"]);
    expect(json.settings.sha256After).not.toBe(json.settings.sha256Written);
  });
  it("does not fail on an unmanaged key", async () => {
    const { result } = await run({ config: { ...ENFORCED }, env: { FAKE_DAEMON_EDIT_SETTINGS: JSON.stringify({ theme: "light" }) } });
    expect(result.errorCode).toBeNull();
  });
});

describe("item 4: auth check after the run (api_key)", () => {
  it("fails when a second provider is added to auth.json during the run, and reports key names only", async () => {
    const { result, json } = await run({ config: { ...ENFORCED, ...API_KEY }, env: { ANTHROPIC_API_KEY: OAT_KEY,
      FAKE_DAEMON_EDIT_AUTH: JSON.stringify({ "openai-codex": { type: "oauth", access: "leaked-access" } }) } });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "prime_auth_tampered" });
    expect(json.authCheck).toEqual({ ok: false, keys: ["anthropic", "openai-codex"], problem: "holds providers [anthropic, openai-codex], expected only [anthropic]" });
    expect(JSON.stringify(result)).not.toContain(OAT_KEY);
    expect(JSON.stringify(result)).not.toContain("leaked-access");
  });
  it("passes an untouched auth.json", async () => {
    const { result, json } = await run({ config: { ...ENFORCED, ...API_KEY }, env: { ANTHROPIC_API_KEY: OAT_KEY } });
    expect(result.errorCode).toBeNull();
    expect(json.authCheck).toEqual({ ok: true, keys: ["anthropic"], problem: null });
  });
});

describe("item 5: per-actor model audit", () => {
  const child = (...turns: unknown[]) => ({ FAKE_DAEMON_AUDIT_CHILD: JSON.stringify(turns) });
  it("fails on one child turn on openai-codex/gpt-6-astra and names the actor", async () => {
    const { result, json } = await run({ config: { ...ENFORCED }, env: child(turn("anthropic", "claude-haiku-4-5"), turn(ASTRA.provider, ASTRA.model)) });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "prime_model_audit_failed", provider: "openai-codex", model: "openai-codex/gpt-6-astra" });
    const audit = json.modelAudit;
    expect(audit).toMatchObject({ ok: false, enforced: true, unreadable: [] });
    expect(audit.forbidden).toEqual([expect.objectContaining({ depth: 1, model: "openai-codex/gpt-6-astra", turns: 1 })]);
    const actor = audit.actors.find((a: { depth: number }) => a.depth === 1);
    expect(actor).toMatchObject({ models: [HAIKU, "openai-codex/gpt-6-astra"], turns: 2, tokens: 30 });
    expect(result.errorMessage).toContain(`actor ${actor.sessionId} (depth 1) ran openai-codex/gpt-6-astra for 1 turn(s)`);
  });
  it("passes the same child with only allowed turns, with the parent and child as actors", async () => {
    const { result, json } = await run({ config: { ...ENFORCED }, env: child(turn("anthropic", "claude-haiku-4-5")) });
    expect(result).toMatchObject({ exitCode: 0, errorCode: null, model: HAIKU });
    expect(json.modelAudit).toMatchObject({ ok: true, forbidden: [], unreadable: [] });
    expect(json.modelAudit.actors.map((a: { depth: number; models: string[] }) => [a.depth, a.models])).toEqual([[0, [HAIKU]], [1, [HAIKU]]]);
  });
  it("fails when a reported child has no session file", async () => {
    const { result, json } = await run({ config: { ...ENFORCED }, env: { ...child(turn("anthropic", "claude-haiku-4-5")), FAKE_DAEMON_AUDIT_CHILD_NO_FILE: "1" } });
    expect(result).toMatchObject({ errorCode: "prime_model_audit_failed", model: "unverified" });
    expect(json.modelAudit.unreadable).toEqual([expect.objectContaining({ reason: "cannot read the session file (ENOENT)" })]);
  });
  it("fails when the daemon reports a child it gives no session file for", async () => {
    const { result, json } = await run({ config: { ...ENFORCED }, env: { FAKE_DAEMON_CHILD_INSIDE: "1" } });
    expect(result.errorCode).toBe("prime_model_audit_failed");
    expect(json.modelAudit.unreadable).toEqual([{ sessionId: null, activeSessionId: "inside", file: null, reason: "the daemon reported this child but no session file for it" }]);
  });
  // TAI-228 finding 2
  it.each([
    ["no model", turn("anthropic", undefined)],
    ["no provider", turn(undefined, "claude-haiku-4-5")],
  ])("fails on a child assistant turn with %s", async (_name, bad) => {
    const { result, json } = await run({ config: { ...ENFORCED }, env: child(turn("anthropic", "claude-haiku-4-5"), bad) });
    expect(result.errorCode).toBe("prime_model_audit_failed");
    expect(json.modelAudit.unreadable).toEqual([expect.objectContaining({ reason: "1 assistant turn(s) have no provider or model" })]);
  });
  it("fails on a child with no assistant turns while the daemon's stats show tokens for it", async () => {
    const { result, json } = await run({ config: { ...ENFORCED }, env: child() });
    expect(result.errorCode).toBe("prime_model_audit_failed");
    expect(json.modelAudit.unreadable).toEqual([expect.objectContaining({ reason: "the daemon's stats show 30 tokens but the file has no assistant turn from this run" })]);
  });
  it("fails when the parent session file cannot be read", async () => {
    const { result, json } = await run({ config: { ...ENFORCED }, env: { FAKE_DAEMON_PARENT_FILE_GONE: "1" } });
    expect(result.errorCode).toBe("prime_model_audit_failed");
    expect(json.modelAudit.unreadable).toEqual([expect.objectContaining({ reason: "cannot read the session file (ENOENT)" })]);
  });
  it("passes a missing parent file only when the daemon's stats show 0 tokens (Prime may write the file with its first turn)", async () => {
    const events = path.join(root, "no-usage.jsonl");
    const message = { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" };
    writeFileSync(events, [{ type: "agent_start" }, { type: "message_end", message }, { type: "agent_end", messages: [message] }].map((e) => JSON.stringify(e)).join("\n"));
    const { result, json } = await run({ config: { ...ENFORCED }, env: { FAKE_DAEMON_PARENT_FILE_GONE: "1", FAKE_DAEMON_EVENTS_FILE: events } });
    expect(result).toMatchObject({ exitCode: 0, errorCode: null });
    expect(json.modelAudit).toMatchObject({ ok: true, unreadable: [], absent: [expect.objectContaining({ reason: "the daemon's stats show 0 tokens" })] });
  });
  it("audits only the turns a resumed session adds in this run", async () => {
    const first = await run({ config: { ...ENFORCED } });
    const file = first.result.sessionParams!.sessionFile as string;
    // A turn from before this run (an earlier run, or an edit between runs) is not this run's usage.
    writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ type: "message", message: turn(ASTRA.provider, ASTRA.model) })}\n`);
    const second = await run({ runId: "run-2", config: { ...ENFORCED }, sessionParams: first.result.sessionParams! });
    expect(second.result).toMatchObject({ errorCode: null, sessionId: first.result.sessionId });
    expect(second.json.modelAudit.actors).toEqual([expect.objectContaining({ file, depth: 0, models: [HAIKU], turns: 1 })]);
  });
  it("audits a print run from its session file", async () => {
    const print = { runtime: "print", command: FAKE_PRINT, ...ENFORCED };
    const ok = await run({ config: print, env: { FAKE_PRIME_WRITE_SESSION: "1" } });
    expect(ok.result).toMatchObject({ exitCode: 0, errorCode: null });
    expect(ok.json.modelAudit).toMatchObject({ ok: true, actors: [expect.objectContaining({ depth: 0, models: [HAIKU], turns: 1 })] });
    const missing = await run({ runId: "run-2", config: print });
    expect(missing.result.errorCode).toBe("prime_model_audit_failed");
  });
});

describe("TAI-228 finding 4: checks 4 and 5 run on every outcome", () => {
  async function cancelled(env: Record<string, string> = {}) {
    const controller = new AbortController();
    const pending = run({ signal: controller.signal, config: { ...ENFORCED, ...API_KEY, graceSec: 0.2 },
      env: { ANTHROPIC_API_KEY: OAT_KEY, FAKE_DAEMON_PROMPT_MODE: "hang", ...env } });
    await vi.waitFor(() => expect(types()).toContain("prompt_and_wait"), { timeout: 5000 });
    controller.abort();
    return await pending;
  }
  it("a cancelled run still writes modelAudit and still runs the auth check", async () => {
    const { result, json } = await cancelled();
    expect(result).toMatchObject({ errorCode: "prime_run_cancelled" });
    expect(json.modelAudit).toMatchObject({ ok: true, enforced: true });
    expect(json.authCheck).toEqual({ ok: true, keys: ["anthropic"], problem: null });
    expect(json.settings).toMatchObject({ tamperedKeys: [] });
  });
  it("a cancelled run with a tampered auth.json fails as prime_auth_tampered and keeps the cancel in errorMeta", async () => {
    const { result, json } = await cancelled({ FAKE_DAEMON_EDIT_AUTH: JSON.stringify({ "openai-codex": { type: "oauth" } }) });
    expect(result).toMatchObject({ errorCode: "prime_auth_tampered", errorMeta: { runErrorCode: "prime_run_cancelled", policyFailures: ["prime_auth_tampered"] } });
    expect(json.modelAudit).toBeDefined();
  });
  it("a timed-out run is checked too", async () => {
    const { result, json } = await run({ config: { ...ENFORCED, timeoutSec: 0.5, graceSec: 0.2 },
      env: { FAKE_DAEMON_PROMPT_MODE: "hang", FAKE_DAEMON_EDIT_SETTINGS: JSON.stringify({ imageModel: "x/y" }) } });
    expect(result).toMatchObject({ timedOut: true, errorCode: "prime_settings_tampered", errorMeta: { runErrorCode: "prime_run_timeout" } });
    expect(json.modelAudit).toBeDefined();
  });
  it("a run whose daemon fails to start is checked too", async () => {
    const { result, json } = await run({ config: { ...ENFORCED }, env: { FAKE_DAEMON_EXIT_AT_START: "1" } });
    expect(result.errorCode).toBe("prime_run_failed");
    expect(json.modelAudit).toMatchObject({ ok: true, actors: [] });
  });
});

describe("items 6 and 7: billing label and the key outside Prime's environment", () => {
  it("labels an sk-ant-oat key subscription with no costUsd, even when Prime reports a cost", async () => {
    const events = path.join(root, "events.jsonl");
    writeFileSync(events, readFileSync(RUN2, "utf8").replace(/"cost":\{[^}]*\}/g, '"cost":{"input":0.1,"output":0.1,"cacheRead":0,"cacheWrite":0,"total":0.5}'));
    const oat = await run({ config: { ...API_KEY }, env: { ANTHROPIC_API_KEY: OAT_KEY, FAKE_DAEMON_EVENTS_FILE: events } });
    expect(oat.result).toMatchObject({ exitCode: 0, billingType: "subscription", costUsd: null });
    const api = await run({ runId: "run-2", config: { ...API_KEY }, env: { ANTHROPIC_API_KEY: "sk-ant-api03-fake-test-key", FAKE_DAEMON_EVENTS_FILE: events } });
    expect(api.result).toMatchObject({ exitCode: 0, billingType: "api" });
    expect(api.result.costUsd).toBeGreaterThan(0);
  });
  it.each(["daemon", "print"])("keeps ANTHROPIC_API_KEY out of the Prime child environment (%s)", async (runtime) => {
    const recordFile = path.join(root, "print.jsonl");
    await run({ config: { ...API_KEY, runtime, ...(runtime === "print" ? { command: FAKE_PRINT } : {}) },
      env: { ANTHROPIC_API_KEY: OAT_KEY, FAKE_PRIME_RECORD: recordFile } });
    const envs = runtime === "daemon" ? starts().map((s) => s.env!) : readFileSync(recordFile, "utf8").trim().split("\n").map((l) => JSON.parse(l).env);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(JSON.parse(readFileSync(authFile(), "utf8"))).toEqual({ anthropic: { type: "api_key", key: OAT_KEY } });
  });
});

describe("allowedModels unset: behaviour is unchanged and the audit only reports", () => {
  it("passes a run with an Astra child, writes no managed key, skips the auth check and reports the actors", async () => {
    const { result, json } = await run({ config: { ...API_KEY }, env: { ANTHROPIC_API_KEY: "sk-ant-api03-fake-test-key",
      FAKE_DAEMON_AUDIT_CHILD: JSON.stringify([turn(ASTRA.provider, ASTRA.model)]), FAKE_DAEMON_EDIT_AUTH: JSON.stringify({ other: {} }) } });
    expect(result).toMatchObject({ exitCode: 0, errorCode: null, model: HAIKU, billingType: "api" });
    expect(json.modelAudit).toMatchObject({ ok: true, enforced: false, forbidden: [] });
    expect(json.modelAudit.actors.flatMap((a: { models: string[] }) => a.models)).toContain("openai-codex/gpt-6-astra");
    expect(json).not.toHaveProperty("authCheck");
    expect(json).not.toHaveProperty("settings");
    expect(existsSync(settingsFile())).toBe(false);
  });
  it("reports an unreadable actor without failing", async () => {
    const { result, json } = await run({ env: { FAKE_DAEMON_PARENT_FILE_GONE: "1" } });
    expect(result).toMatchObject({ exitCode: 0, errorCode: null, model: HAIKU });
    expect(json.modelAudit).toMatchObject({ ok: false, enforced: false });
  });
});

describe("plan section 3.2 config", () => {
  it("runs with the Vega PATCH config shape (fake binary and token)", async () => {
    const home = path.join(root, "prime-user-home");
    mkdirSync(home, { mode: 0o700 });
    const { result, json } = await run({
      config: { model: OPUS, thinking: "high", runtime: "daemon", credentialMode: "api_key", apiKeyEnvVar: "ANTHROPIC_API_KEY",
        allowedModels: [OPUS], subagentDefaultModel: OPUS, rlmMaxDepth: 1, timeoutSec: 3600 },
      env: { ANTHROPIC_API_KEY: OAT_KEY, HOME: home, FAKE_DAEMON_AUDIT_CHILD: JSON.stringify([turn("anthropic", "claude-opus-5-5")]) },
    });
    expect(result).toMatchObject({ exitCode: 0, errorCode: null, provider: "anthropic", model: OPUS, billingType: "subscription", costUsd: null });
    expect(json.modelAudit).toMatchObject({ ok: true });
    expect(json.authCheck).toMatchObject({ ok: true });
    expect(readSettings()).toMatchObject({ allowedModels: [OPUS], subagentDefaultModel: OPUS, defaultModel: "claude-opus-5-5" });
    expect(starts()[0]!.env).toMatchObject({ HOME: home });
    expect(starts()[0]!.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
});
