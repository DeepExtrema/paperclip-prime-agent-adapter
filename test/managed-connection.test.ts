// TAI-273 plan rev 7 §3.2 (C1): managed_subscription, the fail-closed rule, the child-env rule and the error-code rule.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "../src/server/execute.js";
import { PrimeDaemonError } from "../src/server/execute-daemon.js";
import {
  checkPrimeManagedToken, primeManagedRegistration, registerPrimeManagedConnection, resolvePrimeManagedConnection,
} from "../src/server/managed-connection.js";
import { primeProviderFailureKind } from "../src/server/parse.js";
import { buildPrimeChildEnv } from "../src/server/runtime-config.js";
import { testEnvironment } from "../src/server/test.js";
import { PRIME_CHECK_CODES, PRIME_RESULT_ERROR_CODES, type PrimeAgentDirPlan } from "../src/types.js";

const FAKE = fileURLToPath(new URL("./fake-prime-daemon.mjs", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const TOKEN = "sk-ant-oat01-FIXTURE-managed-token-not-real";
const SUFFIX = createHash("sha256").update(TOKEN).digest("hex").slice(0, 16);
const BINDING = { connectionId: "conn-1", grantId: "grant-1", provider: "anthropic", method: "subscription", mode: "responsible_user",
  responsibleUserId: "user-1", identity: `anthropic:subscription:user-1:${SUFFIX}` };
const MODEL = "anthropic/claude-haiku-4-5";
const savedEnv = { ...process.env };
let root = "";
type Rec = { kind: string; env?: Record<string, string>; auth?: unknown; command?: { type: string } };
const rec = () => path.join(root, "daemon.jsonl");
const records = (): Rec[] => (existsSync(rec()) ? readFileSync(rec(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Rec) : []);
const agentDir = () => path.join(root, "agents", "agent-1", "prime-agent-home");
const authFile = () => path.join(agentDir(), "auth.json");
const MANAGED = {
  credentialMode: "managed_subscription", featureProfile: "governed-v1", allowedModels: [MODEL], managedAiConnection: BINDING, thinking: "high",
};
type Over = { config?: Record<string, unknown>; env?: Record<string, string> };
async function run(over: Over = {}) {
  const logs: string[] = [];
  const ctx: AdapterExecutionContext = {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Prime Tester", adapterType: "prime_agent_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      runtime: "daemon", command: FAKE, model: MODEL, agentDirRoot: path.join(root, "agents"), paperclipRuntimeSkills: [],
      ...MANAGED,
      env: { FAKE_DAEMON_RECORD: rec(), FAKE_DAEMON_EVENTS_FILE: fixture("prime-jsonl/run2.jsonl"), FAKE_PRIME_MODEL_LIST: fixture("model-list.txt"),
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "http://127.0.0.1:9/elsewhere", ...over.env },
      ...over.config,
    },
    context: { paperclipWorkspace: { cwd: path.join(root, "ws"), source: "project_primary" }, taskId: "task-1" },
    authToken: "run-jwt-token",
    onLog: async (_stream, chunk) => void logs.push(chunk),
  };
  return { result: await execute(ctx), logs };
}
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "prime-c1-"));
  for (const dir of ["home", "ws", "agents"]) mkdirSync(path.join(root, dir));
  process.env.HOME = path.join(root, "home");
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

describe("C1 registration at module load (§3.2)", () => {
  it("adds prime_agent_local to the anthropic subscription method only, once", async () => {
    const shared = { AI_CONNECTION_CAPABILITIES: { anthropic: { methods: { subscription: { adapters: ["claude_local"] }, api_key: { adapters: ["claude_local"] } } },
      openai: { methods: { subscription: { adapters: ["codex_local"] } } } } };
    expect(await registerPrimeManagedConnection(async () => shared)).toMatchObject({ registered: true });
    await registerPrimeManagedConnection(async () => shared);
    expect(shared.AI_CONNECTION_CAPABILITIES.anthropic.methods.subscription.adapters).toEqual(["claude_local", "prime_agent_local"]);
    expect(shared.AI_CONNECTION_CAPABILITIES.anthropic.methods.api_key.adapters).toEqual(["claude_local"]);
    expect(shared.AI_CONNECTION_CAPABILITIES.openai.methods.subscription.adapters).toEqual(["codex_local"]);
  });
  it("records an unregistered state when the shared module cannot load or has no list", async () => {
    expect(await registerPrimeManagedConnection(async () => { throw new Error("Cannot find package"); })).toMatchObject({ registered: false });
    expect(primeManagedRegistration().message).toContain("Cannot find package");
    expect(await registerPrimeManagedConnection(async () => ({}))).toMatchObject({ registered: false });
    await registerPrimeManagedConnection(); // back to the real module for the tests below
  });
  it("registers in the linked host module, the one the host's select() reads (N0 item 15)", async () => {
    const shared = await import("@paperclipai/shared/ai-connections" as string).catch(() => null);
    if (!shared) return; // no linked host install here
    await registerPrimeManagedConnection();
    expect(primeManagedRegistration().registered).toBe(true);
    expect(shared.AI_CONNECTION_CAPABILITIES.anthropic.methods.subscription.adapters).toContain("prime_agent_local");
    expect(shared.AI_CONNECTION_CAPABILITIES.anthropic.methods.api_key.adapters).not.toContain("prime_agent_local");
  });
});

describe("C1 checks 1-4 and the fail-closed rule (§3.2)", () => {
  const input = { mode: "managed_subscription", provider: "anthropic", allowedModels: [MODEL] };
  const config = (over: Record<string, unknown> = {}) => ({ ...MANAGED, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, ...over });
  it("accepts a matching token and returns the connection id and identity suffix", () => {
    expect(resolvePrimeManagedConnection(config(), input)).toEqual({ connectionId: "conn-1", identitySuffix: SUFFIX });
  });
  it.each([
    ["a binding without managed_subscription (host_auth)", config(), { ...input, mode: "host_auth" }, "Paperclip AI connection"],
    ["a binding without managed_subscription (api_key)", config(), { ...input, mode: "api_key" }, "Paperclip AI connection"],
    ["managed_subscription without governed-v1", config({ featureProfile: undefined }), input, "governed-v1"],
    ["managed_subscription without a binding", config({ managedAiConnection: undefined }), input, "managedAiConnection"],
    ["a binding for another method", config({ managedAiConnection: { ...BINDING, method: "api_key" } }), input, "managedAiConnection"],
    ["a binding with no identity", config({ managedAiConnection: { ...BINDING, identity: "" } }), input, "managedAiConnection"],
    ["a token that is not a subscription token", config({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-api03-x" } }), input, "subscription token"],
    ["no token", config({ env: {} }), input, "subscription token"],
    ["a token that does not match the identity", config({ env: { CLAUDE_CODE_OAUTH_TOKEN: `${TOKEN}-other` } }), input, "does not match"],
    ["a non-anthropic model", config(), { ...input, provider: "openai" }, "anthropic/"],
    ["no allowedModels", config(), { ...input, allowedModels: null }, "allowedModels"],
  ])("refuses %s with prime_managed_connection_invalid", (_name, cfg, inp, text) => {
    expect(() => resolvePrimeManagedConnection(cfg, inp)).toThrowError(expect.objectContaining({ code: "prime_managed_connection_invalid", message: expect.stringContaining(text) }));
  });
  it("lets a config with no binding and no managed mode through", () => {
    expect(resolvePrimeManagedConnection({}, { ...input, mode: "api_key" })).toBeNull();
    expect(() => checkPrimeManagedToken(BINDING, TOKEN)).not.toThrow();
  });
});

describe("C1 run (§3.2, §3.3)", () => {
  it("seeds auth.json from the token for the run, deletes it afterwards and reports the credential", async () => {
    const { result } = await run();
    expect(result).toMatchObject({ exitCode: 0, errorCode: null, billingType: "subscription", costUsd: null,
      resultJson: { credential: { mode: "managed_subscription", connectionId: "conn-1", identitySuffix: SUFFIX } } });
    expect(records().find((r) => r.kind === "auth_at_create")?.auth).toEqual({ anthropic: { type: "api_key", key: TOKEN } });
    expect(existsSync(authFile())).toBe(false);
    const env = records().find((r) => r.kind === "start")!.env!;
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]) expect(env).not.toHaveProperty(key);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
  it.each([
    ["host_auth (default)", {}],
    ["api_key", { credentialMode: "api_key", apiKeyEnvVar: "ANTHROPIC_API_KEY" }],
  ])("fails a binding with %s before any file is written", async (_name, mode) => {
    const { result } = await run({ config: { credentialMode: undefined, ...mode } });
    expect(result).toMatchObject({ errorCode: "prime_managed_connection_invalid", executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, clearSession: false });
    expect(result.errorMessage).toContain("Set credentialMode to managed_subscription, or remove the connection.");
    expect(existsSync(path.join(root, "agents", "agent-1"))).toBe(false);
    expect(records()).toEqual([]);
  });
  it("fails managed_subscription without governed-v1 or without a binding before any file is written (P3c)", async () => {
    for (const config of [{ featureProfile: undefined }, { managedAiConnection: undefined }]) {
      const { result } = await run({ config });
      expect(result).toMatchObject({ errorCode: "prime_managed_connection_invalid", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(existsSync(path.join(root, "agents", "agent-1"))).toBe(false);
    }
  });
  it("deletes auth.json after a preflight failure that follows the write", async () => {
    const { result } = await run({ config: { model: "anthropic/claude-not-listed", allowedModels: ["anthropic/claude-not-listed"] } });
    expect(result).toMatchObject({ errorCode: "prime_preflight_failed", errorMeta: { primeErrorCode: "prime_model_unknown" },
      resultJson: { credential: { identitySuffix: SUFFIX } } });
    expect(existsSync(authFile())).toBe(false);
  });
  // TAI-324 T4: every preflight step after the write. TMPDIR is read when the skills are staged, after the model list.
  it.each([
    ["the model list fails", () => ({ env: { FAKE_PRIME_MODEL_LIST: path.join(root, "missing-model-list.txt") } }), "prime_preflight_failed", "prime_model_list_failed", "model list` failed"],
    ["the skills cannot be staged", () => { process.env.TMPDIR = path.join(root, "no-tmp"); return {}; }, "prime_preflight_failed", null, "paperclip-prime-skills-"],
    ["settings.json is a directory", () => { mkdirSync(path.join(agentDir(), "settings.json"), { recursive: true }); return {}; }, "prime_settings_invalid", "prime_settings_invalid", "cannot be read (EISDIR)"],
    ["settings.json is not JSON", () => { mkdirSync(agentDir(), { recursive: true }); writeFileSync(path.join(agentDir(), "settings.json"), "{"); return {}; }, "prime_settings_invalid", "prime_settings_invalid", "is not a JSON object"],
  ])("deletes auth.json when %s", async (_name, setUp, errorCode, primeErrorCode, text) => {
    const over = setUp();
    const { result } = await run(over);
    expect(result).toMatchObject({ errorCode, errorMeta: { primeErrorCode }, resultJson: { credential: { identitySuffix: SUFFIX } } });
    expect(result.errorMessage).toContain(text);
    expect(existsSync(authFile())).toBe(false);
    expect(records().filter((r) => r.kind === "start")).toEqual([]);
  });
  it("fails a run whose auth.json changed with prime_auth_tampered, and still deletes it", async () => {
    const { result } = await run({ env: { FAKE_DAEMON_EDIT_AUTH: JSON.stringify({ openai: { type: "api_key", key: "x" } }) } });
    expect(result).toMatchObject({ errorCode: "prime_auth_tampered", resultJson: { authCheck: { ok: false, keys: ["anthropic", "openai"] } } });
    expect(existsSync(authFile())).toBe(false);
  });
  it("fails with prime_auth_cleanup_failed and names the path when auth.json cannot be deleted", async () => {
    const { result, logs } = await run({ env: { FAKE_DAEMON_AUTH_DIR: "1" } });
    expect(result).toMatchObject({ errorCode: "prime_auth_cleanup_failed", errorMeta: { runErrorCode: "prime_auth_tampered" } });
    expect(result.sessionParams).toBeUndefined();
    expect(logs.join("")).toContain(`Could not delete ${authFile()}`);
  });
});

describe("error codes (§3.2, N0 item 14)", () => {
  it.each([["auth", "prime_provider_auth_failed"], ["rate_limit", "prime_provider_quota"]])("maps a %s diagnostic to %s and keeps the session", async (kind, code) => {
    const { result } = await run({ env: { FAKE_DAEMON_PROMPT_MODE: "error", FAKE_DAEMON_PROMPT_DIAGNOSTIC: kind,
      FAKE_DAEMON_PROMPT_ERROR: "Provider authentication failed (authentication_error, 401): invalid x-api-key" } });
    expect(result).toMatchObject({ errorCode: code, clearSession: false });
  });
  it("reads the kind from the last failed assistant message only", () => {
    const failed = (kind: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", diagnostics: [{ details: { kind } }] } });
    expect(primeProviderFailureKind([failed("auth"), failed("rate_limit")].join("\n"))).toBe("rate_limit");
    expect(primeProviderFailureKind(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", diagnostics: [{ details: { kind: "auth" } }] } }))).toBeNull();
    expect(primeProviderFailureKind("not json")).toBeNull();
  });
  it("returns no code the host's isAiAuthenticationFailure treats as a login failure (F16, P0)", async () => {
    const app = process.env.PAPERCLIP_APP_DIR ?? path.join(os.userInfo().homedir, ".paperclip/cli/installs/local/2026.1005.0-prime.reinstall.1/app");
    const module = path.join(app, "server/dist/services/ai-auth-failure.js");
    if (!existsSync(module)) return; // no running install on this host
    const { isAiAuthenticationFailure } = await import(pathToFileURL(module).href) as { isAiAuthenticationFailure: (code: string) => boolean };
    const daemon = ["prime_daemon_start_failed", "prime_daemon_socket_unsafe", "prime_daemon_protocol_error", "prime_daemon_closed", "prime_daemon_request_timeout"];
    const all = [...PRIME_RESULT_ERROR_CODES, ...PRIME_CHECK_CODES, ...daemon, "prime_native_config_invalid", "prime_preflight_failed",
      "prime_host_auth_missing", "prime_host_auth_unsafe", "prime_api_key_missing", "prime_auth_file_unsafe", "prime_agent_dir_unsafe"];
    expect(all.filter((code) => isAiAuthenticationFailure(code))).toEqual([]);
    expect(isAiAuthenticationFailure("pi_auth_required")).toBe(true); // the check itself works
    expect(new PrimeDaemonError("prime_daemon_closed", "x").code).toBe("prime_daemon_closed");
  });
});

describe("child env (§3.2)", () => {
  const plan = (mode: "host_auth" | "api_key"): PrimeAgentDirPlan => ({ kind: "agent", agentDir: "/a", sessionDir: "/a/sessions",
    credential: mode === "host_auth" ? { mode, hostAuthFile: "/h" } : { mode, provider: "anthropic", apiKeyEnvVar: "ANTHROPIC_API_KEY" } });
  it("always removes CLAUDE_CODE_OAUTH_TOKEN, and every ANTHROPIC_* key only when asked", () => {
    const paperclipEnv = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_API_KEY: "k", OTHER: "1" };
    const plain = buildPrimeChildEnv({}, plan("host_auth"), paperclipEnv).env;
    expect([plain.CLAUDE_CODE_OAUTH_TOKEN, plain.ANTHROPIC_BASE_URL, plain.ANTHROPIC_API_KEY, plain.OTHER]).toEqual([undefined, "http://x", "k", "1"]);
    const apiKey = buildPrimeChildEnv({}, plan("api_key"), paperclipEnv).env;
    expect([apiKey.ANTHROPIC_BASE_URL, apiKey.ANTHROPIC_API_KEY]).toEqual(["http://x", undefined]);
    const stripped = buildPrimeChildEnv({}, plan("api_key"), paperclipEnv, { stripAnthropicEnv: true }).env;
    expect([stripped.CLAUDE_CODE_OAUTH_TOKEN, stripped.ANTHROPIC_BASE_URL, stripped.ANTHROPIC_API_KEY, stripped.OTHER]).toEqual([undefined, undefined, undefined, "1"]);
  });
});

describe("testEnvironment (§3.2)", () => {
  const envTest = (config: Record<string, unknown>) => testEnvironment({ companyId: "company-1", adapterType: "prime_agent_local",
    config: { command: FAKE, model: MODEL, cwd: path.join(root, "ws"), ...config } });
  const codes = (result: Awaited<ReturnType<typeof testEnvironment>>) => result.checks.map((c) => `${c.level}:${c.code}`);
  it("reports the registration and the token check, and lists no models", async () => {
    const result = await envTest({ ...MANAGED, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
    expect(codes(result)).toEqual(expect.arrayContaining(["info:prime_auth_managed_registered", "info:prime_auth_managed_token_ok", "info:prime_models_skipped"]));
    expect(result.status).toBe("pass");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
  it("fails a token that does not match, and a binding without managed_subscription", async () => {
    const mismatch = await envTest({ ...MANAGED, env: { CLAUDE_CODE_OAUTH_TOKEN: `${TOKEN}-x` } });
    expect(codes(mismatch)).toContain("error:prime_managed_connection_invalid");
    expect(codes(mismatch)).not.toContain("info:prime_auth_managed_token_ok");
    const bound = await envTest({ managedAiConnection: BINDING, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
    expect([bound.status, codes(bound)]).toEqual(["fail", ["error:prime_managed_connection_invalid"]]);
  });
  it("reports prime_auth_managed_unregistered as an error when the registration failed (TAI-324 T6)", async () => {
    await registerPrimeManagedConnection(async () => { throw new Error("Cannot find package '@paperclipai/shared'"); });
    try {
      const result = await envTest({ ...MANAGED, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
      expect(codes(result)).toContain("error:prime_auth_managed_unregistered");
      expect(codes(result)).not.toContain("info:prime_auth_managed_registered");
      expect(result.status).toBe("fail");
      expect(result.checks.find((c) => c.code === "prime_auth_managed_unregistered")?.message).toContain("Cannot find package");
    } finally {
      await registerPrimeManagedConnection();
    }
  });
  it("checks the config without a token in the body, and reports no token check", async () => {
    const result = await envTest({ credentialMode: "managed_subscription", featureProfile: "governed-v1", allowedModels: [MODEL] });
    expect(codes(result)).toContain("info:prime_auth_managed_registered");
    expect(codes(result)).not.toContain("info:prime_auth_managed_token_ok");
    const ungoverned = await envTest({ credentialMode: "managed_subscription", allowedModels: [MODEL] });
    expect(codes(ungoverned)).toContain("error:prime_managed_connection_invalid");
  });
});

describe("written token file shape", () => {
  it("leaves the token in no file of the agent dir after a run (secret scan)", async () => {
    await run();
    const scan = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return scan(full);
      return readFileSync(full, "utf8").includes(TOKEN) ? [full] : [];
    });
    expect(scan(agentDir())).toEqual([]);
  });
});
