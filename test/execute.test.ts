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
