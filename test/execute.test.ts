import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildPrimeArgs, execute } from "../src/server/execute.js";
const FAKE = fileURLToPath(new URL("./fake-prime-agent.mjs", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const [RUN1, RUN2, RUN3] = ["run1", "run2", "run3"].map((run) => fixture(`prime-jsonl/${run}.jsonl`));
const [SESSION2, savedEnv] = ["01a14c2a-5965-7269-8920-97d0da73b791", { ...process.env }];
let root = "";
type Call = { argv: string[]; cwd: string; env: Record<string, string>; pid: number };
const [rec, ws] = [() => path.join(root, "calls.jsonl"), () => path.join(root, "ws")];
const [agentDir, sessionDir] = [() => path.join(root, "agents", "agent-1", "prime-agent-home"), () => path.join(root, "agents", "agent-1", "prime-agent-home", "sessions")];
const calls = (): Call[] => (existsSync(rec()) ? readFileSync(rec(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Call) : []);
const runCalls = () => calls().filter((call) => call.argv[0] === "--mode");
const appendArgs = (argv: string[]) => argv.flatMap((arg, i) => (arg === "--append-system-prompt" ? [argv[i + 1]] : []));
function writeSavedSession(cwd = ws(), sessionFile = path.join(sessionDir(), `${SESSION2}.jsonl`)) {
  mkdirSync(sessionDir(), { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: SESSION2, cwd })}\n`);
  return { sessionId: SESSION2, sessionFile, cwd, provider: "anthropic", model: "claude-haiku-4-5", agentDir: agentDir() };
}
type Over = { config?: Record<string, unknown>; env?: Record<string, string>; sessionParams?: Record<string, unknown>; executionTarget?: unknown; signal?: AbortSignal };
function makeCtx(over: Over = {}) {
  const logs: Array<[string, string]> = [];
  const metas: AdapterInvocationMeta[] = [];
  const ctx: AdapterExecutionContext = {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Prime Tester", adapterType: "prime_agent_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: over.sessionParams ?? null, sessionDisplayId: null, taskKey: null },
    config: {
      command: FAKE, model: "anthropic/claude-haiku-4-5", hostAuthFile: path.join(root, "host-auth.json"),
      agentDirRoot: path.join(root, "agents"), paperclipRuntimeSkills: [],
      env: { FAKE_PRIME_RECORD: rec(), FAKE_PRIME_STDOUT_FILE: RUN2, FAKE_PRIME_MODEL_LIST: fixture("model-list.txt"), ...over.env },
      ...over.config,
    },
    context: {
      paperclipWorkspace: { cwd: ws(), source: "project_primary" }, taskId: "task-1", wakeReason: "issue_assigned",
      wakeCommentId: "comment-1", paperclipTaskMarkdown: "## Task\nReply with PELICAN-7.",
    },
    executionTarget: over.executionTarget as AdapterExecutionContext["executionTarget"], signal: over.signal, authToken: "run-jwt-token",
    onLog: async (stream, chunk) => void logs.push([stream, chunk]), onMeta: async (meta) => void metas.push(meta),
  };
  return { ctx, logs, metas };
}
const run = async (over: Over = {}) => {
  const made = makeCtx(over);
  return { ...made, result: await execute(made.ctx) };
};
beforeAll(() => chmodSync(FAKE, 0o755));
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "prime-wp3-"));
  for (const dir of ["home", "ws", "agents"]) mkdirSync(path.join(root, dir));
  process.env.HOME = path.join(root, "home");
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
  const hostAuth = { anthropic: { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 0 } };
  writeFileSync(path.join(root, "host-auth.json"), JSON.stringify(hostAuth), { mode: 0o600 });
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});
describe("buildPrimeArgs (INTERFACES §5)", () => {
  it("emits every flag in the frozen order with the prompt last after --", () => {
    const args = buildPrimeArgs({
      provider: "vercel-ai-gateway", model: "openai/gpt-6.1-sol", thinking: "low", cwd: "/w", sessionDir: "/a/sessions",
      resumeSessionFile: "/a/sessions/s1.jsonl", skillDirs: ["/s/one", "/s/two"], appendSystemPrompts: ["SYS", "", "EXTRA"],
      noContextFiles: true, extraArgs: ["--offline"], prompt: "-- do it",
    });
    expect(args).toEqual([
      "--mode", "json", "-p", "--provider", "vercel-ai-gateway", "--model", "openai/gpt-6.1-sol", "--thinking", "low",
      "--cwd", "/w", "--session-dir", "/a/sessions", "-r", "/a/sessions/s1.jsonl", "--skill", "/s/one", "--skill", "/s/two",
      "--append-system-prompt", "SYS", "--append-system-prompt", "EXTRA", "--no-context-files", "--offline", "--", "-- do it",
    ]);
  });
  it("omits every optional flag for a minimal fresh run", () => {
    const base = { provider: "anthropic", model: "claude-haiku-4-5", thinking: null, cwd: "/w", sessionDir: "/a/sessions", resumeSessionFile: null };
    const args = buildPrimeArgs({ ...base, skillDirs: [], appendSystemPrompts: ["", "  "], noContextFiles: false, extraArgs: [], prompt: "hi" });
    expect(args).toEqual(["--mode", "json", "-p", "--provider", "anthropic", "--model", "claude-haiku-4-5", "--cwd", "/w", "--session-dir", "/a/sessions", "--", "hi"]);
  });
});
describe("execute: fresh run (INTERFACES §11.3, §11.5, §11.7)", () => {
  it("spawns prime-agent once with the §5 argv and Paperclip env, and maps a completed run", async () => {
    process.env.DATABASE_URL = "postgres://paperclip:pw@127.0.0.1:5432/paperclip";
    const { result, metas } = await run({ config: { appendSystemPrompt: "EXTRA-SYS" } });
    expect(runCalls()).toHaveLength(1);
    const { argv, cwd, env } = runCalls()[0]!;
    expect(argv.slice(0, 11)).toEqual(["--mode", "json", "-p", "--provider", "anthropic", "--model", "claude-haiku-4-5", "--cwd", ws(), "--session-dir", sessionDir()]);
    expect(argv).not.toContain("-r");
    expect(appendArgs(argv).map((text, i) => (i === 0 ? text.includes("You are agent agent-1 (Prime Tester).") : text))).toEqual([true, "EXTRA-SYS"]);
    expect([argv.at(-2), argv.at(-1)?.includes("Reply with PELICAN-7."), cwd]).toEqual(["--", true, ws()]);
    expect(env).toMatchObject({
      PAPERCLIP_API_KEY: "run-jwt-token", PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_AGENT_ID: "agent-1", PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_TASK_ID: "task-1", PAPERCLIP_WAKE_REASON: "issue_assigned", PAPERCLIP_WAKE_COMMENT_ID: "comment-1",
      PAPERCLIP_WORKSPACE_CWD: ws(), PRIME_AGENT_CODING_AGENT_DIR: agentDir(), PRIME_AGENT_TELEMETRY: "0",
    });
    expect([env.PAPERCLIP_API_URL?.startsWith("http"), lstatSync(path.join(agentDir(), "auth.json")).isSymbolicLink()]).toEqual([true, true]);
    expect(metas.map((meta) => [meta.adapterType, meta.commandArgs])).toEqual([["prime_agent_local", argv]]);
    expect(metas[0]!.env?.PAPERCLIP_API_KEY).not.toBe("run-jwt-token");
    expect(metas[0]!.env).not.toHaveProperty("LANG");
    expect([metas[0]!.env?.DATABASE_URL, metas[0]!.env?.PRIME_AGENT_CODING_AGENT_DIR, metas[0]!.env?.HOME]).toEqual([undefined, agentDir(), path.join(root, "home")]);
    expect(result).toEqual({
      exitCode: 0, signal: null, timedOut: false, errorCode: null, errorMessage: null,
      provider: "anthropic", model: "anthropic/claude-haiku-4-5", biller: "anthropic", billingType: "subscription",
      usage: { inputTokens: 3, outputTokens: 4, cachedInputTokens: 0 }, usageBasis: "per_run", costUsd: null,
      resultJson: { stdout: readFileSync(RUN2, "utf8"), stderr: "", cacheWriteTokens: 10553, totalTokens: 10560 },
      sessionId: SESSION2, sessionDisplayId: SESSION2, summary: "OK", clearSession: false,
      sessionParams: { sessionId: SESSION2, sessionFile: path.join(sessionDir(), `${SESSION2}.jsonl`), cwd: ws(), provider: "anthropic", model: "claude-haiku-4-5", agentDir: agentDir() },
    });
  });
  it("passes each staged skill with --skill and removes the staging dir afterwards", async () => {
    const skill = path.join(root, "skill-src", "paperclip-check");
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "---\nname: paperclip-check\ndescription: test skill\n---\n");
    await run({ config: {
      paperclipRuntimeSkills: [{ key: "local/paperclip-check", runtimeName: "paperclip-check", source: skill }],
      paperclipSkillSync: { desiredSkills: ["local/paperclip-check"] },
    } });
    const argv = runCalls()[0]!.argv;
    const staged = argv[argv.indexOf("--skill") + 1]!;
    expect([path.basename(staged), existsSync(staged)]).toEqual(["paperclip-check", false]);
  });
});
describe("execute: child env hygiene (INTERFACES §4, §16 A8, A17, L17)", () => {
  it("does not pass inherited Prime, RLM or PI variables or ambient provider keys to prime-agent", async () => {
    Object.assign(process.env, {
      PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "leak", RLM_SESSION_DIR: "/leak", PI_CODING_AGENT_DIR: "/leak",
      PRIME_AGENT_CODING_AGENT_DIR: "/elsewhere", ANTHROPIC_API_KEY: "ambient-key", PAPERCLIP_AGENT_JWT_SECRET: "leak",
    });
    await run();
    const env = runCalls()[0]!.env;
    expect(Object.keys(env).filter((key) => /^(PRIME_AGENT_INTERNAL_|RLM_|PI_)/.test(key) || ["ANTHROPIC_API_KEY", "PAPERCLIP_AGENT_JWT_SECRET"].includes(key))).toEqual([]);
    expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBe(agentDir());
  });
});
describe("execute: instructions file (pi-local execute.ts 574-635)", () => {
  it("puts the instructions file first in the system prompt and reports it in onMeta notes", async () => {
    const file = path.join(ws(), "AGENTS.md");
    writeFileSync(file, "INSTRUCTIONS-MARKER\n");
    const { metas } = await run({ config: { instructionsFilePath: file } });
    const first = appendArgs(runCalls()[0]!.argv)[0];
    expect(first).toContain("INSTRUCTIONS-MARKER");
    expect(first).toContain(`The above agent instructions were loaded from ${file}.`);
    expect(metas[0]!.commandNotes).toContain(`Loaded agent instructions from ${file}`);
  });
});
describe("execute: resume (INTERFACES §11.4, §7, §16 A2)", () => {
  const notResumed = (reason: string) => ["stdout", `[paperclip] Prime session "${SESSION2}" will not be resumed (${reason}); starting a fresh session.\n`];
  it("resumes a matching saved session with -r and keeps its params", async () => {
    const saved = writeSavedSession();
    const { result } = await run({ sessionParams: saved, env: { FAKE_PRIME_STDOUT_FILE: RUN3 } });
    expect(runCalls()[0]!.argv.slice(11, 13)).toEqual(["-r", saved.sessionFile]);
    expect(result.sessionParams).toEqual(saved);
    expect(result.summary).toBe("PELICAN");
  });
  it("never passes a missing session file to -r", async () => {
    const saved = writeSavedSession();
    rmSync(saved.sessionFile);
    const { logs } = await run({ sessionParams: saved });
    expect(runCalls()[0]!.argv).not.toContain("-r");
    expect(logs).toContainEqual(notResumed("session_file_missing"));
  });
});
describe("execute: unknown session (INTERFACES §11.6)", () => {
  it("retries once with a fresh session and clears the stored session", async () => {
    const { result, logs } = await run({ sessionParams: writeSavedSession(), env: { FAKE_PRIME_RESUME_MODE: "unknown_session" } });
    expect(runCalls().map((call) => call.argv.includes("-r"))).toEqual([true, false]);
    expect(logs).toContainEqual(["stdout", `[paperclip] Prime session "${SESSION2}" is unavailable; retrying with a fresh session.\n`]);
    expect(result).toMatchObject({ exitCode: 0, errorCode: null, clearSession: true });
    expect(result).not.toHaveProperty("sessionParams");
  });
});
describe("execute: failed runs (INTERFACES §11.7)", () => {
  it("maps a provider error reported with exit 0 to prime_run_failed with Prime's message", async () => {
    const { result } = await run({ env: { FAKE_PRIME_STDOUT_FILE: RUN1 } });
    expect(result).toMatchObject({ exitCode: 1, timedOut: false, errorCode: "prime_run_failed", errorMessage: "No AWS credentials available for Bedrock", clearSession: false });
    expect(result).not.toHaveProperty("sessionParams");
  });
  it("maps a non-zero exit to prime_run_failed with the first stderr line", async () => {
    const { result } = await run({ env: { FAKE_PRIME_EXIT_CODE: "2", FAKE_PRIME_STDERR: "boom: provider unreachable\nmore\n" } });
    expect(result).toMatchObject({ exitCode: 2, errorCode: "prime_run_failed", errorMessage: "boom: provider unreachable" });
    expect(result).not.toHaveProperty("sessionParams");
  });
});
describe("execute: uncertain runs (INTERFACES §11.7, L8)", () => {
  it("maps a run without agent_end to prime_run_uncertain, never success, and keeps the session", async () => {
    const { result } = await run({ env: { FAKE_PRIME_MODE: "drop_agent_end" } });
    expect(result).toMatchObject({ exitCode: 1, timedOut: false, errorCode: "prime_run_uncertain", clearSession: false });
    expect(result).not.toHaveProperty("sessionParams");
  });
});
describe("execute: timeout (INTERFACES §11.1, §11.7, L9)", () => {
  it("kills a run that ignores SIGTERM after graceSec and maps it to prime_run_timeout", async () => {
    const { result } = await run({ config: { timeoutSec: 2, graceSec: 1 }, env: { FAKE_PRIME_MODE: "hang", FAKE_PRIME_IGNORE_TERM: "1" } });
    expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL", errorCode: "prime_run_timeout", errorMessage: "Timed out after 2s", clearSession: false });
    expect(result).not.toHaveProperty("sessionParams");
    expect(() => process.kill(runCalls()[0]!.pid, 0)).toThrow();
  }, 15_000);
  it("counts the timeout from execute start, not from spawn", async () => {
    const started = Date.now();
    const { result } = await run({ config: { timeoutSec: 2, graceSec: 1 }, env: { FAKE_PRIME_MODE: "hang", FAKE_PRIME_VERSION_DELAY_MS: "1500" } });
    expect([result.timedOut, Date.now() - started < 3000]).toEqual([true, true]);
  }, 15_000);
});
describe("execute: cost (MASTER-PLAN decisions, INTERFACES §11.7, §16 A3)", () => {
  const priced = (total: string) => {
    const file = path.join(root, "run2-priced.jsonl");
    writeFileSync(file, readFileSync(RUN2, "utf8").replaceAll('"total":0.0', `"total":${total}`));
    return file;
  };
  it("reports Prime's cost for API-key billing", async () => {
    const { result } = await run({
      config: { credentialMode: "api_key", apiKeyEnvVar: "ANTHROPIC_API_KEY" },
      env: { ANTHROPIC_API_KEY: "sk-test-not-real", FAKE_PRIME_STDOUT_FILE: priced("0.0125") },
    });
    expect(result).toMatchObject({ billingType: "api", costUsd: 0.0125 });
  });
  it("reports no cost for a subscription run even when Prime estimates one", async () => {
    const { result } = await run({ env: { FAKE_PRIME_STDOUT_FILE: priced("0.0132") } });
    expect(result).toMatchObject({ billingType: "subscription", costUsd: null });
  });
});
describe("execute: onLog streaming (pi-local execute.ts 714-753)", () => {
  it("forwards stdout as whole lines while prime-agent writes partial chunks", async () => {
    const { logs } = await run({ env: { FAKE_PRIME_CHUNK_BYTES: "500" } });
    const chunks = logs.filter(([stream, chunk]) => stream === "stdout" && !chunk.startsWith("[paperclip]")).map(([, chunk]) => chunk);
    expect(chunks.every((chunk) => chunk.indexOf("\n") === chunk.length - 1)).toBe(true);
    expect(chunks.join("")).toBe(readFileSync(RUN2, "utf8"));
  });
});
describe("execute: preflight refusals (INTERFACES §11.2, §11.3)", () => {
  it("returns prime_preflight_failed without a run when the host auth file is missing", async () => {
    const { result } = await run({ config: { hostAuthFile: path.join(root, "missing-auth.json") } });
    const meta = { errorMeta: { primeErrorCode: "prime_host_auth_missing" }, clearSession: false, errorMessage: expect.any(String) };
    expect(result).toEqual({ exitCode: 1, signal: null, timedOut: false, errorCode: "prime_preflight_failed", ...meta });
    expect(runCalls()).toEqual([]);
  });
  it("refuses a remote execution target before any prime-agent call", async () => {
    const { result } = await run({ executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" } });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "prime_preflight_failed", errorMeta: { primeErrorCode: null } });
    expect(result.errorMessage).toContain("runs only on the local Paperclip host");
    expect(calls()).toEqual([]);
  });
});
describe("execute: CLI checks before seeding and spawn (INTERFACES §11.3, §8, §16 A9)", () => {
  it("refuses an unsupported prime-agent version before the agent dir is created", async () => {
    const { result } = await run({ env: { FAKE_PRIME_VERSION: "0.11.0" } });
    expect(result).toMatchObject({ errorCode: "prime_preflight_failed", errorMeta: { primeErrorCode: "prime_cli_version_unsupported" } });
    expect(existsSync(agentDir())).toBe(false);
    expect(runCalls()).toEqual([]);
  });
  it("refuses a model that prime-agent model list does not show", async () => {
    const { result } = await run({ config: { model: "anthropic/claude-not-a-model" } });
    expect(result).toMatchObject({ errorCode: "prime_preflight_failed", errorMeta: { primeErrorCode: "prime_model_unknown" } });
    expect(calls().map((call) => call.argv.slice(0, 2))).toEqual([["--version"], ["model", "list"]]);
  });
});
