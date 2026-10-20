import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrimeDaemonClient, resolvePrimeNativeConfig, primeDaemonSocketPlan } from "../src/server/execute-daemon.js";
import net from "node:net";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { getPrimeConfigSchema } from "../src/server/config-schema.js";
import { buildPrimeLocalConfig } from "../src/ui/build-config.js";
import { execute } from "../src/server/execute.js";
import { primeSessionCodec } from "../src/server/session.js";
const FAKE = fileURLToPath(new URL("./fake-prime-daemon.mjs", import.meta.url));
const FAKE_PRINT = fileURLToPath(new URL("./fake-prime-agent.mjs", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const RUN2 = fixture("prime-jsonl/run2.jsonl");
const SESSION2 = "01a14c2a-5965-7269-8920-97d0da73b791";
const savedEnv = { ...process.env };
let root = "";
type Rec = { pid: number; kind: string; argv?: string[]; env?: Record<string, string>; command?: Record<string, unknown> & { type: string } };
const rec = () => path.join(root, "daemon.jsonl");
const records = (): Rec[] => (existsSync(rec()) ? readFileSync(rec(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Rec) : []);
const commands = () => records().filter((r) => r.kind === "command").map((r) => r.command!);
const types = () => commands().map((c) => c.type);
const starts = () => records().filter((r) => r.kind === "start");
const ws = () => path.join(root, "ws");
const agentDir = () => path.join(root, "agents", "agent-1", "prime-agent-home");
const sessionDir = () => path.join(agentDir(), "sessions");
type Over = { config?: Record<string, unknown>; env?: Record<string, string>; sessionParams?: Record<string, unknown>; signal?: AbortSignal; runId?: string };
function makeCtx(over: Over = {}) {
  const logs: string[] = [];
  const hooks = { dispatch: 0, spawn: 0 };
  const ctx: AdapterExecutionContext = {
    runId: over.runId ?? "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Prime Tester", adapterType: "prime_agent_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: over.sessionParams ?? null, sessionDisplayId: null, taskKey: null },
    config: {
      runtime: "daemon", command: FAKE, model: "anthropic/claude-haiku-4-5", hostAuthFile: path.join(root, "host-auth.json"),
      agentDirRoot: path.join(root, "agents"), paperclipRuntimeSkills: [],
      env: { FAKE_DAEMON_RECORD: rec(), FAKE_DAEMON_EVENTS_FILE: RUN2, FAKE_PRIME_MODEL_LIST: fixture("model-list.txt"), ...over.env },
      ...over.config,
    },
    context: { paperclipWorkspace: { cwd: ws(), source: "project_primary" }, taskId: "task-1", paperclipTaskMarkdown: "## Task\nReply with PELICAN-7." },
    signal: over.signal, authToken: "run-jwt-token",
    onLog: async (_stream, chunk) => void logs.push(chunk),
    onDispatch: () => void (hooks.dispatch += 1),
    onSpawn: async () => void (hooks.spawn += 1),
  };
  return { ctx, logs, hooks };
}
const run = async (over: Over = {}) => {
  const made = makeCtx(over);
  return { ...made, result: await execute(made.ctx) };
};
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "prime-wp9b-"));
  for (const dir of ["home", "ws", "agents"]) mkdirSync(path.join(root, dir));
  process.env.HOME = path.join(root, "home");
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
  writeFileSync(path.join(root, "host-auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 0 } }), { mode: 0o600 });
});
afterEach(async () => {
  try {
    for (const { pid } of starts()) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  }
});


describe("client", () => {
let root = "";
let server: net.Server | null = null;
const received: unknown[] = [];
/** A scripted daemon: hello split in two chunks; answers "echo" by id; "wrap" emits an enveloped event first; "silent" never answers. */
function listen(sock: string) {
  return new Promise<void>((resolve) => {
    server = net.createServer((socket) => {
      const hello = JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, appVersion: "0.10.0" });
      socket.write(hello.slice(0, 10));
      setTimeout(() => socket.write(`${hello.slice(10)}\n`), 20);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const msg = JSON.parse(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
          received.push(msg);
          const { type } = msg.command;
          if (type === "wrap") socket.write(`${JSON.stringify({ type: "event", id: "e1", event: { type: "session_event", activeSessionId: "s1", event: { type: "agent_end" } } })}\n`);
          if (type === "hangup") socket.destroy();
          else if (type !== "silent") socket.write(`${JSON.stringify({ id: msg.id, type: "response", command: type, success: type !== "bad", ...(type === "bad" ? { error: "Unknown daemon command: bad" } : { data: { n: 1 } }) })}\n`);
        }
      });
    }).listen(sock, () => resolve());
  });
}
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "prime-wp9b-client-")); received.length = 0; });
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = null;
  rmSync(root, { recursive: true, force: true });
});
describe("client wire shapes", () => {
  it("waits for a split hello, sends v7 envelopes with unique ids and routes responses by id", async () => {
    const sock = path.join(root, "d.sock");
    await listen(sock);
    const client = await PrimeDaemonClient.connect(sock);
    expect(client.hello).toMatchObject({ type: "daemon_hello", appVersion: "0.10.0" });
    const [a, b] = await Promise.all([client.request({ type: "list" }, 2000), client.request({ type: "bad" }, 2000)]);
    expect(a).toEqual({ id: "pc-1", type: "response", command: "list", success: true, data: { n: 1 } });
    expect(b).toEqual({ id: "pc-2", type: "response", command: "bad", success: false, error: "Unknown daemon command: bad" });
    expect(received).toEqual([
      { type: "command", id: "pc-1", protocol: { name: "prime-agent.daemon", version: 7 }, command: { type: "list" } },
      { type: "command", id: "pc-2", protocol: { name: "prime-agent.daemon", version: 7 }, command: { type: "bad" } },
    ]);
    client.close();
  });
  it("unwraps {type:event} envelopes for listeners", async () => {
    const sock = path.join(root, "d.sock");
    await listen(sock);
    const client = await PrimeDaemonClient.connect(sock);
    const seen: unknown[] = [];
    client.onMessage((m) => seen.push(m));
    await client.request({ type: "wrap" }, 2000);
    expect(seen).toEqual([{ type: "session_event", activeSessionId: "s1", event: { type: "agent_end" } }]);
    client.close();
  });
  it("rejects on timeout (prime_daemon_request_timeout) and on a closed connection (prime_daemon_closed)", async () => {
    const sock = path.join(root, "d.sock");
    await listen(sock);
    const client = await PrimeDaemonClient.connect(sock);
    await expect(client.request({ type: "silent" }, 100)).rejects.toMatchObject({ code: "prime_daemon_request_timeout" });
    const pending = client.request({ type: "silent" }, null);
    await expect(client.request({ type: "hangup" }, null)).rejects.toMatchObject({ code: "prime_daemon_closed" });
    await expect(pending).rejects.toMatchObject({ code: "prime_daemon_closed" });
    expect(client.closed?.code).toBe("prime_daemon_closed");
    await expect(PrimeDaemonClient.connect(path.join(root, "missing.sock"))).rejects.toMatchObject({ code: "prime_daemon_closed" });
  });
});

});
describe("daemon client UTF8 review regression", () => {
  it.each(["response", "event"])("preserves a split multibyte character in a %s", async kind => {
    const root = mkdtempSync(path.join(os.tmpdir(), "prime-wp9b-utf8-"));
    const socketPath = path.join(root, "d.sock");
    const server = net.createServer(socket => {
      socket.write(`${JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 } })}\n`);
      socket.once("data", chunk => {
        const request = JSON.parse(chunk.toString());
        const response = { type: "response", id: request.id, command: request.command.type, success: true, data: { text: "€" } };
        const event = { type: "session_event", activeSessionId: "target", event: { type: "message_end", text: "€" } };
        const bytes = Buffer.from(`${JSON.stringify(kind === "response" ? response : event)}\n`);
        const splitAt = bytes.indexOf(Buffer.from("€")) + 1;
        socket.write(bytes.subarray(0, splitAt));
        setTimeout(() => {
          socket.write(bytes.subarray(splitAt));
          if (kind === "event") socket.write(`${JSON.stringify(response)}\n`);
        }, 30);
      });
    });
    let client: PrimeDaemonClient | null = null;
    try {
      await new Promise<void>(resolve => server.listen(socketPath, resolve));
      client = await PrimeDaemonClient.connect(socketPath);
      const seen: unknown[] = [];
      client.onMessage(message => seen.push(message));
      const response = await client.request({ type: "text" }, 1000);
      if (kind === "response") expect(response.data).toEqual({ text: "€" });
      else expect(seen).toEqual([{ type: "session_event", activeSessionId: "target", event: { type: "message_end", text: "€" } }]);
    } finally {
      client?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "prime_agent_local", cwd: "", instructionsFilePath: "", promptTemplate: "", model: "", thinkingEffort: "",
    chrome: false, dangerouslySkipPermissions: false, search: false, fastMode: false, dangerouslyBypassSandbox: false,
    command: "", args: "", extraArgs: "", envVars: "", envBindings: {}, url: "", bootstrapPrompt: "",
    maxTurnsPerRun: 1000, heartbeatEnabled: false, intervalSec: 300, ...overrides,
  };
}


const gone = (pid: number) => expect(() => process.kill(pid, 0)).toThrow();
async function waitCommand(type: string) {
  await vi.waitFor(() => expect(types()).toContain(type), { timeout: 5000 });
}
async function cancelRun(hard = false, ignoreTerm = false) {
  const controller = new AbortController();
  const pending = run({ signal: controller.signal, config: { graceSec: 0.2 }, env: {
    FAKE_DAEMON_PROMPT_MODE: hard ? "hang_hard" : "hang", ...(ignoreTerm ? { FAKE_DAEMON_IGNORE_TERM: "1" } : {}),
  } });
  await waitCommand("prompt_and_wait"); controller.abort();
  return await pending;
}
describe("daemon per run", () => {
  it("waits for a late child reply even without goal or autonomous mode", async () => {
    const { result } = await run({ env: { FAKE_DAEMON_LATE_CHILD: "1" } });
    expect(result).toMatchObject({ exitCode: 0, summary: "CHILD SAID KESTREL-4" });
    expect(types()[types().indexOf("prompt_and_wait") + 1]).toBe("wait_for_headless_completion");
  });
  it("returns the same persisted session shape as print and resumes it through the codec", async () => {
    const printed = await run({ config: { runtime: "print", command: FAKE_PRINT }, env: { FAKE_PRIME_STDOUT_FILE: RUN2 } });
    const first = await run();
    expect(first.result.sessionParams).not.toBeNull(); expect(first.result.sessionParams).toBeDefined();
    expect(Object.keys(first.result.sessionParams!).sort()).toEqual(Object.keys(printed.result.sessionParams!).sort());
    const saved = primeSessionCodec.serialize(first.result.sessionParams!);
    expect(saved).toEqual(first.result.sessionParams);
    const second = await run({ runId: "run-2", sessionParams: primeSessionCodec.deserialize(saved)! });
    expect(second.result.sessionId).toBe(first.result.sessionId);
    expect(second.result.sessionParams!.sessionId).toBe(first.result.sessionParams!.sessionId);
  });

  it("defaults native config to print and rejects goal without daemon", () => {
    expect(resolvePrimeNativeConfig({})).toEqual({ runtime: "print", goal: null, autonomous: null, rlmMaxDepth: null, subagentDefaultModel: null });
    expect(() => resolvePrimeNativeConfig({ goal: "x" })).toThrow('adapterConfig.goal and adapterConfig.autonomous need runtime "daemon".');
  });
  it("maps native goal and autonomous config", () => {
    expect(resolvePrimeNativeConfig({ runtime: "daemon", goal: "Ship the report", goalTokenBudget: "5000", autonomous: true,
      autonomousMaxTurns: 4, autonomousMaxTokens: "20000", autonomousGates: "npm test\n\n test -f done.txt ",
      autonomousGateRetries: 2, rlmMaxDepth: 0, subagentDefaultModel: " anthropic/claude-haiku-4-5 " })).toEqual({
      runtime: "daemon", goal: { objective: "Ship the report", tokenBudget: 5000 },
      autonomous: { enabled: true, maxTurns: 4, maxTokens: 20000, maxContinuations: null, timeoutMs: null,
        gates: { commands: ["npm test", "test -f done.txt"], maxRetries: 2, timeoutMs: null } },
      rlmMaxDepth: 0, subagentDefaultModel: "anthropic/claude-haiku-4-5",
    });
  });
  it("rejects invalid native values with prime_native_config_invalid", () => {
    for (const config of [{ runtime: "rpc" }, { autonomousMaxTurns: 3 }, { autonomous: true, autonomousMaxTurns: 0 },
      { goalTokenBudget: 10 }, { rlmMaxDepth: -1 }, { subagentDefaultModel: "haiku" }, { autonomous: "yes" }])
      expect(() => resolvePrimeNativeConfig(config)).toThrowError(expect.objectContaining({ code: "prime_native_config_invalid" }));
  });
  it("schema create-form defaults resolve like empty config", () => {
    const defaults: Record<string, unknown> = {};
    for (const f of getPrimeConfigSchema().fields) {
      const value = f.default ?? (f.type === "toggle" ? false : f.type === "number" ? 0 : f.type === "select" ? f.options?.[0]?.value ?? "" : "");
      if (value !== "") defaults[f.key] = value;
    }
    expect(resolvePrimeNativeConfig(defaults)).toEqual(resolvePrimeNativeConfig({}));
  });
  it("copies all thirteen native schema keys", () => {
    const values = { runtime: "daemon", goal: "Ship it\n", goalTokenBudget: 500, autonomous: true, autonomousMaxTurns: "4",
      autonomousMaxTokens: 50, autonomousMaxContinuations: 2, autonomousTimeoutMs: 5000, autonomousGates: "npm test\n",
      autonomousGateRetries: 1, autonomousGateTimeoutMs: 500, rlmMaxDepth: 1, subagentDefaultModel: "anthropic/claude-haiku-4-5" };
    expect(buildPrimeLocalConfig(makeValues({ adapterSchemaValues: values }))).toEqual({ timeoutSec: 0, graceSec: 20, ...values });
  });
  it("fresh run emits events, reports usage, uses scoped env and stops its daemon", async () => {
    process.env.ANTHROPIC_API_KEY = "host-key-must-not-leak";
    const { result, logs, hooks } = await run();
    expect(result).toMatchObject({ exitCode: 0, errorCode: null, summary: "OK", clearSession: false,
      usage: { inputTokens: 3, outputTokens: 4, cachedInputTokens: 0 }, usageBasis: "per_run",
      resultJson: { runtime: "daemon", sessionStatsDelta: { input: 3, output: 4, cacheRead: 0, cacheWrite: 10553, total: 10560, cost: 0 } } });
    expect(types()).toEqual(["create", "attach", "get_session_stats", "prompt_and_wait", "wait_for_headless_completion", "get_last_assistant_text", "get_session_stats", "shutdown"]);
    const params = result.sessionParams as Record<string, string>;
    expect(params.sessionFile).toBe(path.join(sessionDir(), `${params.sessionId}.jsonl`));
    expect(params.agentDir).toBe(agentDir());
    const s = starts()[0]!; const sock = s.argv![3]!;
    expect(s.argv).toEqual(["--mode", "daemon", "--daemon-socket", sock]); expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(100);
    expect(s.env).toMatchObject({ PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_API_KEY: "run-jwt-token", PRIME_AGENT_CODING_AGENT_DIR: agentDir(), PRIME_AGENT_TELEMETRY: "0" });
    expect(s.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(JSON.parse(logs[0]!)).toMatchObject({ type: "session", id: params.sessionId, cwd: ws() });
    expect(logs.filter(l => l.includes('"type":"agent_end"'))).toHaveLength(1); expect(hooks.spawn).toBe(1);
    gone(s.pid); expect(existsSync(sock)).toBe(false);
  });
  it("resumes the file with a new daemon and the same session id", async () => {
    const first = await run(); const params = first.result.sessionParams!;
    const second = await run({ runId: "run-2", sessionParams: params });
    expect(commands().filter(c => c.type === "create")[1]).toMatchObject({ sessionPath: params.sessionFile });
    expect(second.result.sessionParams?.sessionId).toBe(params.sessionId);
    expect(starts()[0]!.pid).not.toBe(starts()[1]!.pid); starts().forEach(s => gone(s.pid));
  });
  it("sends goal/autonomous and depth then waits for headless completion", async () => {
    await run({ config: { goal: "Ship it", autonomous: true, rlmMaxDepth: 1 } });
    expect(commands()[0]).toMatchObject({ config: { initialGoal: { objective: "Ship it" }, autonomous: { enabled: true } } });
    expect(commands()).toContainEqual(expect.objectContaining({ type: "set_rlm_max_depth", maxDepth: 1 }));
    expect(types()[types().indexOf("prompt_and_wait") + 1]).toBe("wait_for_headless_completion");
  });
  it("fails on a headless completion error", async () => {
    const { result } = await run({ config: { autonomous: true }, env: { FAKE_DAEMON_HEADLESS_ERROR: "boom" } });
    expect(result).toMatchObject({ errorCode: "prime_run_failed", errorMessage: "boom" }); gone(starts()[0]!.pid);
  });
  it("fails on provider error and stops", async () => {
    const { result } = await run({ env: { FAKE_DAEMON_PROMPT_MODE: "error" } });
    expect(result).toMatchObject({ errorCode: "prime_run_failed", errorMessage: "No API key found for anthropic." }); gone(starts()[0]!.pid);
  });
  it("cancels a hang with abort then shutdown", async () => {
    const { result } = await cancelRun(); expect(types()).toContain("abort"); expect(types()).toContain("shutdown");
    expect(result).toMatchObject({ errorCode: "prime_run_cancelled", errorMessage: "Run cancelled." }); gone(starts()[0]!.pid);
  });
  it("cancels a hard hang with SIGTERM", async () => {
    const { result } = await cancelRun(true); expect(types()).toContain("abort");
    expect(result).toMatchObject({ errorCode: "prime_run_cancelled" }); gone(starts()[0]!.pid);
  });
  it("SIGKILLs a hard hang that ignores SIGTERM", async () => {
    const { result } = await cancelRun(true, true); expect(records().some(r => r.kind === "sigterm_ignored")).toBe(true);
    expect(result).toMatchObject({ errorCode: "prime_run_cancelled" }); gone(starts()[0]!.pid);
  });
  it("times out a hang", async () => {
    const { result } = await run({ config: { timeoutSec: 0.5, graceSec: 0.2 }, env: { FAKE_DAEMON_PROMPT_MODE: "hang" } });
    expect(result).toMatchObject({ timedOut: true, errorCode: "prime_run_timeout", exitCode: null }); gone(starts()[0]!.pid);
  });
  it("marks a killed daemon uncertain and does not preserve session params", async () => {
    const pending = run({ env: { FAKE_DAEMON_PROMPT_MODE: "hang_hard" } }); await waitCommand("prompt_and_wait");
    process.kill(-starts()[0]!.pid, "SIGKILL"); const { result } = await pending;
    expect(result.errorCode).toBe("prime_run_uncertain"); expect(result.sessionParams).toBeUndefined(); expect(result.errorMessage).toContain("Daemon stderr:");
  });
  it("reports startup stderr on early exit", async () => {
    const { result } = await run({ env: { FAKE_DAEMON_EXIT_AT_START: "1" } });
    expect(result.errorCode).toBe("prime_run_failed"); expect(result.errorMessage).toContain("boom at start"); gone(starts()[0]!.pid);
  });
  it("unwraps enveloped events for a successful run", async () => {
    const { result } = await run({ env: { FAKE_DAEMON_ENVELOPE_EVENTS: "1" } }); expect(result).toMatchObject({ exitCode: 0, summary: "OK" });
  });
  it("substitutes a short TMPDIR only when needed", () => {
    const uid = process.getuid?.() ?? 0;
    const long = primeDaemonSocketPlan({ TMPDIR: "/" + "x".repeat(59), FOO: "bar", MISSING: undefined }, uid);
    expect(long.env).toEqual({ TMPDIR: `/tmp/paperclip-prime-${uid}/tmp`, FOO: "bar" }); expect(Buffer.byteLength(long.socketPath)).toBeLessThanOrEqual(100);
    expect(primeDaemonSocketPlan({ TMPDIR: "/tmp" }, uid).env.TMPDIR).toBe("/tmp");
  });
  it("writes subagentDefaultModel in private agent settings", async () => {
    await run({ config: { subagentDefaultModel: "anthropic/claude-haiku-4-5" } });
    const file = path.join(agentDir(), "settings.json"); expect(JSON.parse(readFileSync(file, "utf8")).subagentDefaultModel).toBe("anthropic/claude-haiku-4-5"); expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("leaves print runs on the print path", async () => {
    const { result } = await run({ config: { runtime: "print", command: FAKE_PRINT }, env: { FAKE_PRIME_STDOUT_FILE: RUN2 } });
    expect(result.exitCode).toBe(0); expect(starts()).toEqual([]);
  });
});
