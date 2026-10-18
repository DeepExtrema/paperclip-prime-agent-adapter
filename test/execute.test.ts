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
