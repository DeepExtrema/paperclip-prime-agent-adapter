import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { buildInvocationEnvForLogs, resolveCommandForLogs } from "@paperclipai/adapter-utils/server-utils";
import { PRIME_ADAPTER_TYPE, type ParsedPrimeOutput, type PrimeSessionParams } from "../types.js";
import type { PreparedRun, SystemPrompt } from "./execute.js";
import { parsePrimeJsonl } from "./parse.js";
export type PrimeDaemonErrorCode =
  | "prime_daemon_start_failed"
  | "prime_daemon_socket_unsafe"
  | "prime_daemon_protocol_error"
  | "prime_daemon_closed"
  | "prime_daemon_request_timeout";

export class PrimeDaemonError extends Error {
  readonly code: PrimeDaemonErrorCode;
  constructor(code: PrimeDaemonErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PrimeDaemonError";
    this.code = code;
  }
}

export const PRIME_DAEMON_PROTOCOL = { name: "prime-agent.daemon", version: 7 } as const;
export function primeDaemonEnvelope(id: string, command: Record<string, unknown>) {
  return { type: "command", id, protocol: PRIME_DAEMON_PROTOCOL, command };
}
import net from "node:net";

export type PrimeDaemonMessage = Record<string, unknown> & { type: string };
export interface PrimeDaemonResponse {
  id: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}
type Pending = { resolve: (response: PrimeDaemonResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | null; type: string };

export class PrimeDaemonClient {
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(message: PrimeDaemonMessage) => void>();
  private closedError: PrimeDaemonError | null = null;
  private helloMessage: PrimeDaemonMessage | null = null;

  private constructor(private readonly socket: net.Socket, private readonly socketPath: string) {}

  /** Connects and resolves after daemon_hello. */
  static connect(socketPath: string, helloTimeoutMs = 5000): Promise<PrimeDaemonClient> {
    return new Promise((resolve, reject) => {
      const client = new PrimeDaemonClient(net.createConnection(socketPath), socketPath);
      const timer = setTimeout(() => {
        client.close();
        reject(new PrimeDaemonError("prime_daemon_request_timeout", `No daemon_hello on ${socketPath} within ${helloTimeoutMs} ms.`));
      }, helloTimeoutMs);
      client.socket.setEncoding("utf8");
      client.socket.on("data", (chunk: string) => client.onData(chunk, () => {
        clearTimeout(timer);
        resolve(client);
      }));
      client.socket.on("error", (err) => client.fail(`Daemon connection error on ${socketPath}: ${err.message}`));
      client.socket.on("close", () => {
        client.fail(`Daemon connection on ${socketPath} closed.`);
        clearTimeout(timer);
        if (!client.helloMessage) reject(client.closedError!);
      });
    });
  }

  get hello(): PrimeDaemonMessage {
    return this.helloMessage!;
  }

  /** The close reason once the connection is gone, else null. */
  get closed(): PrimeDaemonError | null {
    return this.closedError;
  }

  /** Resolves with the daemon response (success or not). Rejects only on timeout or a closed connection. timeoutMs null = no timeout. */
  request(command: Record<string, unknown> & { type: string }, timeoutMs: number | null): Promise<PrimeDaemonResponse> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = `pc-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new PrimeDaemonError("prime_daemon_request_timeout", `No answer to "${command.type}" from ${this.socketPath} within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, type: command.type });
      this.socket.write(`${JSON.stringify(primeDaemonEnvelope(id, command))}\n`);
    });
  }

  /** Every message that is not the hello or a response to a pending request. Returns an unsubscribe function. */
  onMessage(listener: (message: PrimeDaemonMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.fail(`Daemon connection on ${this.socketPath} closed by the adapter.`);
    this.socket.destroy();
  }

  private fail(message: string): void {
    if (this.closedError) return;
    this.closedError = new PrimeDaemonError("prime_daemon_closed", message);
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(this.closedError);
    }
  }

  private onData(chunk: string, onHello: () => void): void {
    this.buffer += chunk;
    for (let index = this.buffer.indexOf("\n"); index >= 0; index = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message !== "object" || message === null) continue;
      let wire = message as PrimeDaemonMessage;
      if (wire.type === "event" && typeof wire.event === "object" && wire.event !== null) wire = wire.event as PrimeDaemonMessage;
      if (wire.type === "daemon_hello" && !this.helloMessage) {
        this.helloMessage = wire;
        onHello();
        continue;
      }
      const pending = wire.type === "response" && typeof wire.id === "string" ? this.pending.get(wire.id) : undefined;
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(wire.id as string);
        pending.resolve(wire as unknown as PrimeDaemonResponse);
        continue;
      }
      for (const listener of this.listeners) listener(wire);
    }
  }
}
const isUnset = (value: unknown): boolean => value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const trimmedText = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const rawText = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
export class PrimeNativeConfigError extends Error { readonly code = "prime_native_config_invalid" as const; constructor(message: string) { super(message);
    this.name = "PrimeNativeConfigError"; } } export interface PrimeNativeAutonomousConfig {
  enabled: true; maxTurns: number | null; maxTokens: number | null; maxContinuations: number | null; timeoutMs: number | null;
  gates: { commands: string[]; maxRetries: number | null; timeoutMs: number | null }; } export interface PrimeNativeConfig { runtime: "daemon" | "print";
  goal: { objective: string; tokenBudget: number | null } | null; autonomous: PrimeNativeAutonomousConfig | null; rlmMaxDepth: number | null;
  subagentDefaultModel: string | null; } const AUTONOMOUS_LIMIT_KEYS = [ "autonomousMaxTurns", "autonomousMaxTokens", "autonomousMaxContinuations", "autonomousTimeoutMs",
  "autonomousGates", "autonomousGateRetries", "autonomousGateTimeoutMs", ] as const;
function integerKey(config: Record<string, unknown>, key: string, min: number): number | null { const value = config[key]; if (isUnset(value)) return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN; if (!Number.isInteger(parsed) || parsed < min) {
    throw new PrimeNativeConfigError(`adapterConfig.${key} must be an integer >= ${min}.`); } return parsed; }
function booleanKey(config: Record<string, unknown>, key: string): boolean { const value = config[key]; if (isUnset(value)) return false;
  if (typeof value !== "boolean") throw new PrimeNativeConfigError(`adapterConfig.${key} must be true or false.`); return value; }
function gateCommands(value: unknown): string[] { if (isUnset(value)) return [];
  const list = typeof value === "string" ? value.split("\n") : Array.isArray(value) ? value : null; if (list === null || list.some((item) => typeof item !== "string")) {
    throw new PrimeNativeConfigError("adapterConfig.autonomousGates must be a list of shell commands (or one command per line)."); }
  return (list as string[]).map((item) => item.trim()).filter(Boolean); } export function resolvePrimeNativeConfig(config: Record<string, unknown>): PrimeNativeConfig {
  const runtime = isUnset(config.runtime) ? "print" : config.runtime; if (runtime !== "daemon" && runtime !== "print") {
    throw new PrimeNativeConfigError('adapterConfig.runtime must be "print" or "daemon".'); } if (!isUnset(config.goal) && typeof config.goal !== "string") {
    throw new PrimeNativeConfigError("adapterConfig.goal must be a string."); } const objective = rawText(config.goal);
  const tokenBudget = integerKey(config, "goalTokenBudget", 1);
  if (objective === null && tokenBudget !== null) throw new PrimeNativeConfigError("adapterConfig.goalTokenBudget needs adapterConfig.goal.");
  const autonomousOn = booleanKey(config, "autonomous"); if (!autonomousOn && AUTONOMOUS_LIMIT_KEYS.some((key) => !isUnset(config[key]))) {
    throw new PrimeNativeConfigError("adapterConfig.autonomous* limits need adapterConfig.autonomous: true."); }
  const autonomous: PrimeNativeAutonomousConfig | null = autonomousOn ? {
        enabled: true, maxTurns: integerKey(config, "autonomousMaxTurns", 1), maxTokens: integerKey(config, "autonomousMaxTokens", 1), maxContinuations: integerKey(config, "autonomousMaxContinuations", 1), timeoutMs: integerKey(config, "autonomousTimeoutMs", 1),
        gates: {
          commands: gateCommands(config.autonomousGates), maxRetries: integerKey(config, "autonomousGateRetries", 1), timeoutMs: integerKey(config, "autonomousGateTimeoutMs", 1),
        }, } : null; if (!isUnset(config.subagentDefaultModel) && typeof config.subagentDefaultModel !== "string") {
    throw new PrimeNativeConfigError("adapterConfig.subagentDefaultModel must be a string in provider/modelId form."); }
  const subagentDefaultModel = trimmedText(config.subagentDefaultModel); if (subagentDefaultModel !== null) { const slash = subagentDefaultModel.indexOf("/");
    if (slash <= 0 || slash === subagentDefaultModel.length - 1) { throw new PrimeNativeConfigError("adapterConfig.subagentDefaultModel must be provider/modelId."); } }
  if (runtime === "print" && (objective !== null || autonomous !== null)) throw new PrimeNativeConfigError('adapterConfig.goal and adapterConfig.autonomous need runtime "daemon".');
  return { runtime, goal: objective === null ? null : { objective, tokenBudget }, autonomous, rlmMaxDepth: integerKey(config, "rlmMaxDepth", 0), subagentDefaultModel, };
}
async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await fs.rename(temp, file);
}
async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
export function primeDaemonSocketPlan(childEnv: Record<string, string | undefined>, userId = process.getuid?.() ?? 0) {
  const env = Object.fromEntries(Object.entries(childEnv).filter((entry): entry is [string, string] => entry[1] !== undefined));
  if (Buffer.byteLength(env.TMPDIR ?? "/tmp") + 55 > 100) env.TMPDIR = `/tmp/paperclip-prime-${userId}/tmp`;
  const socketPath = path.join(env.TMPDIR ?? "/tmp", `paperclip-prime-${userId}`, `${randomBytes(8).toString("hex")}.sock`);
  if (Buffer.byteLength(socketPath) > 100) throw new PrimeDaemonError("prime_daemon_socket_unsafe", `Daemon socket path is longer than 100 bytes: ${socketPath}`);
  return { env, socketPath };
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const signalGroup = (pid: number, signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; } };
type RunDaemon = { pid: number; socketPath: string; stderrTail: string; client: PrimeDaemonClient; stopDaemon: () => Promise<void> };
async function startDaemon(ctx: AdapterExecutionContext, prep: PreparedRun): Promise<RunDaemon> {
  const { env, socketPath } = primeDaemonSocketPlan(prep.childEnv);
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  if (env.TMPDIR && env.TMPDIR !== prep.childEnv.TMPDIR) await fs.mkdir(env.TMPDIR, { recursive: true, mode: 0o700 });
  const child = spawn(prep.runtime.command, ["--mode", "daemon", "--daemon-socket", socketPath], { cwd: prep.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let exited = false, exitCode: number | null = null, stderrTail = "";
  let spawnError: Error | null = null;
  let client: PrimeDaemonClient | null = null;
  const exit = new Promise<void>(resolve => {
    child.once("exit", code => { exited = true; exitCode = code; client?.close(); resolve(); });
    child.once("error", err => { spawnError = err; exited = true; resolve(); });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { const text = chunk.toString(); stderrTail = (stderrTail + text).slice(-2000); void ctx.onLog("stderr", text); });
  const stopDaemon = async () => {
    try {
      if (!exited) {
        await client?.request({ type: "shutdown" }, 5000).catch(() => undefined);
        await Promise.race([exit, delay(5000)]);
        if (!exited) { signalGroup(child.pid!, "SIGTERM"); await Promise.race([exit, delay(prep.runtime.graceSec * 1000)]); }
        if (!exited) { signalGroup(child.pid!, "SIGKILL"); await exit; }
      }
    } finally { client?.close(); await fs.rm(socketPath, { force: true }); }
  };
  try {
    if (child.pid) await ctx.onSpawn?.({ pid: child.pid, processGroupId: child.pid, startedAt: new Date().toISOString() });
    const until = Date.now() + 20_000;
    while (!exited && Date.now() < until) {
      try { client = await PrimeDaemonClient.connect(socketPath, 1000); break; } catch { await delay(50); }
    }
    if (!client || exited) {
      if (!exited && child.pid) { signalGroup(child.pid, "SIGKILL"); await exit; }
      throw new PrimeDaemonError("prime_daemon_start_failed", `prime-agent daemon did not start (exit ${exitCode}). stderr: ${stderrTail}${spawnError ? ` ${spawnError.message}` : ""}`);
    }
    return { pid: child.pid!, socketPath, get stderrTail() { return stderrTail; }, client, stopDaemon };
  } catch (err) { await stopDaemon(); throw err; }
}
type Stage = "create_failed" | "prompt_failed" | "completed" | "closed" | "timed_out" | "cancelled";
type StatsDelta = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number };
type SessionSummary = { activeSessionId: string; sessionId: string; sessionFile: string; provider: string | null; model: string | null; thinkingLevel: string | null };
type Outcome = { stage: Stage; error: string | null; stdout: string; parsed: ParsedPrimeOutput; session: SessionSummary | null;
  lastText: string | null; statsDelta: StatsDelta | null; autonomousStatus: unknown; };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null); function readSummary(data: unknown): SessionSummary | null {
  if (!isObject(data)) return null; const [activeSessionId, sessionId, sessionFile] = [str(data.activeSessionId), str(data.sessionId), str(data.sessionFile)];
  if (!activeSessionId || !sessionId || !sessionFile) return null; const model = isObject(data.model) ? data.model : {};
  return { activeSessionId, sessionId, sessionFile, provider: str(model.provider), model: str(model.id), thinkingLevel: str(data.thinkingLevel) }; }
function readStats(response: PrimeDaemonResponse | null): StatsDelta | null { const data = response?.success ? response.data : null;
  if (!isObject(data) || !isObject(data.tokens)) return null; const t = data.tokens;
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return { input: n(t.input), output: n(t.output), cacheRead: n(t.cacheRead), cacheWrite: n(t.cacheWrite), total: n(t.total), cost: n(data.cost) }; }
function delta(before: StatsDelta | null, after: StatsDelta | null): StatsDelta | null { if (!before || !after) return null;
  return { input: after.input - before.input, output: after.output - before.output, cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite, total: after.total - before.total, cost: after.cost - before.cost }; }
function createConfig(prep: PreparedRun, native: PrimeNativeConfig, system: SystemPrompt): Record<string, unknown> { const { runtime, cwd } = prep;
  const a = native.autonomous; const set = <T>(key: string, value: T | null) => (value === null ? {} : { [key]: value }); return {
    cwd, agentDir: runtime.agentDir.agentDir, sessionDir: runtime.agentDir.sessionDir, provider: runtime.provider, model: runtime.model, ...set("thinking", runtime.thinking),
    appendSystemPrompt: [system.text, runtime.appendSystemPrompt ?? ""].filter((text) => text.trim().length > 0), skills: prep.skills.skillDirs,
    ...(runtime.noContextFiles ? { noContextFiles: true } : {}),
    ...(a ? { autonomous: { enabled: true, ...set("maxTurns", a.maxTurns), ...set("maxTokens", a.maxTokens), ...set("maxContinuations", a.maxContinuations),
      ...set("timeoutMs", a.timeoutMs), gates: { commands: a.gates.commands, ...set("maxRetries", a.gates.maxRetries), ...set("timeoutMs", a.gates.timeoutMs) } } } : {}),
    ...(native.goal ? { initialGoal: { objective: native.goal.objective, ...set("tokenBudget", native.goal.tokenBudget) } } : {}), serializedRefine: true,
    telemetryDisabled: true, }; }
function watchStop(ctx: AdapterExecutionContext, prep: PreparedRun, client: PrimeDaemonClient, activeSessionId: string, pid: number) {
  let reason: "cancelled" | "timed_out" | null = null;
  let disposed = false; const timers: NodeJS.Timeout[] = [];
  const fire = (why: "cancelled" | "timed_out") => {
    if (disposed || reason) return;
    reason = why;
    void client.request({ type: "abort", activeSessionId }, 10_000).catch(() => undefined);
    timers.push(setTimeout(() => {
      if (disposed) return;
      signalGroup(pid, "SIGTERM");
      timers.push(setTimeout(() => { if (!disposed) signalGroup(pid, "SIGKILL"); }, prep.runtime.graceSec * 1000));
    }, prep.runtime.graceSec * 1000));
  };
  const onAbort = () => fire("cancelled");
  if (ctx.signal?.aborted) fire("cancelled");
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  if (prep.deadlineMs !== null) timers.push(setTimeout(() => fire("timed_out"), Math.max(1, prep.deadlineMs - Date.now())));
  return { reason: () => reason, dispose: () => { disposed = true; ctx.signal?.removeEventListener("abort", onAbort); for (const t of timers) clearTimeout(t); } };
}
function pendingStop(ctx: AdapterExecutionContext, prep: PreparedRun): "cancelled" | "timed_out" | null {
  if (ctx.signal?.aborted) return "cancelled";
  return prep.deadlineMs !== null && Date.now() >= prep.deadlineMs ? "timed_out" : null;
}
async function runAttempt(
  ctx: AdapterExecutionContext, prep: PreparedRun, native: PrimeNativeConfig, system: SystemPrompt, notes: string[],
  daemon: RunDaemon, resumeSessionFile: string | null, userPrompt: (resumed: boolean) => string,
): Promise<Outcome> {
  const { runtime, cwd } = prep;
  let stdout = ""; let logChain = Promise.resolve();
  const emit = (line: string) => {
    stdout += line; logChain = logChain.then(() => ctx.onLog("stdout", line));
  };
  let session: SessionSummary | null = null;
  let autonomousStatus: unknown = null;
  let terminalSessionError: string | null = null;
  let stop: ReturnType<typeof watchStop> | null = null;
  const stopReason = () => stop?.reason() ?? pendingStop(ctx, prep);
  const outcome = async (stage: Stage, error: string | null, extra: Partial<Outcome> = {}): Promise<Outcome> => {
    await logChain;
    const reason = stopReason();
    if (reason) {
      stage = reason;
      error = null;
    } else if (stage === "completed" && terminalSessionError !== null) {
      stage = "closed";
      error = `${terminalSessionError} Daemon stderr: ${daemon.stderrTail}`;
    }
    stop?.dispose();
    return { stage, error, stdout, parsed: parsePrimeJsonl(stdout), session, lastText: null, statsDelta: null, autonomousStatus, ...extra };
  };
  if (stopReason()) return await outcome(stopReason()!, null);
  const client = daemon.client;
  let unsubscribe: (() => void) | null = null;
  try {
    if (stopReason()) return await outcome(stopReason()!, null);
    const config = createConfig(prep, native, system);
    let selectedId: string | null = null;
    const closeSelected = (id: string, reason: string) => {
      terminalSessionError = `Prime session ${id} closed (${reason}).`;
      client.close(); // Reject local waits only; no session/daemon command.
    };
    unsubscribe = client.onMessage((message) => {
      const id = str(message.activeSessionId);
      if (message.type === "session_closed" && id) {
        const reason = str(message.reason) ?? "no reason supplied";
        if (selectedId === id) closeSelected(id, reason);
      } else if (selectedId === id && message.type === "session_event" && isObject(message.event)) emit(`${JSON.stringify(message.event)}\n`);
    });
    if (stopReason()) return await outcome(stopReason()!, null);
    const created = await client.request({ type: "create", lifecycle: "resident", config, ...(resumeSessionFile ? { sessionPath: resumeSessionFile } : {}) }, 60_000);
    session = created.success ? readSummary(created.data) : null;
    if (!session) return await outcome("create_failed", created.error ?? `Unexpected create response: ${JSON.stringify(created).slice(0, 300)}`);
    const sid = session.activeSessionId;
    selectedId = sid;
    const must = async (command: Record<string, unknown> & { type: string }) => {
      const response = await client.request({ ...command, activeSessionId: sid }, 30_000);
      if (!response.success) throw new PrimeDaemonError("prime_daemon_protocol_error", `${command.type} failed: ${response.error ?? "no error text"}`);
      return response;
    };
    if (session.provider !== runtime.provider || session.model !== runtime.model) await must({ type: "set_model", provider: runtime.provider, modelId: runtime.model });
    if (runtime.thinking !== null && session.thinkingLevel !== runtime.thinking) await must({ type: "set_thinking_level", level: runtime.thinking });
    if (native.rlmMaxDepth !== null) await must({ type: "set_rlm_max_depth", maxDepth: native.rlmMaxDepth });
    emit(`${JSON.stringify({ type: "session", version: 3, id: session.sessionId, timestamp: new Date().toISOString(), cwd })}\n`);
    await must({ type: "attach" });
    const prompt = userPrompt(resumeSessionFile !== null);
    const resolvedCommand = await resolveCommandForLogs(runtime.command, cwd, prep.childEnv);
    const runtimeEnv = Object.fromEntries(Object.entries(prep.childEnv).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const loggedKeys = new Set([...Object.keys(prep.paperclipEnv), "PRIME_AGENT_CODING_AGENT_DIR", "PRIME_AGENT_TELEMETRY"]); // A18
    await ctx.onMeta?.({
      adapterType: PRIME_ADAPTER_TYPE, command: resolvedCommand, cwd,
      commandNotes: [...notes, `Prime daemon pid ${daemon.pid} (per run), socket ${daemon.socketPath}, session ${session.sessionId}.`],
      commandArgs: ["--mode", "daemon", "--daemon-socket", daemon.socketPath],
      env: buildInvocationEnvForLogs(Object.fromEntries(Object.entries(runtimeEnv).filter(([key]) => loggedKeys.has(key))), { runtimeEnv, includeRuntimeKeys: ["HOME"], resolvedCommand }),
      prompt, promptMetrics: { systemPromptChars: system.text.length, promptChars: prompt.length }, context: ctx.context,
    });
    const before = readStats(await client.request({ type: "get_session_stats", activeSessionId: sid }, 30_000));
    if (stopReason()) return await outcome(stopReason()!, null);
    stop = watchStop(ctx, prep, client, sid, daemon.pid);
    if (stopReason()) return await outcome(stopReason()!, null);
    const prompted = await client.request({ type: "prompt_and_wait", activeSessionId: sid, message: prompt, queueIfBusy: false }, null);
    if (stopReason()) return await outcome(stopReason()!, null);
    if (!prompted.success) {
      const error = prompted.error ?? "prompt_and_wait failed without an error text.";
      return await outcome("prompt_failed", error);
    }
    {
      const headless = await client.request({ type: "wait_for_headless_completion", activeSessionId: sid }, null);
      autonomousStatus = headless.success ? headless.data ?? null : { error: headless.error ?? null };
      if (stopReason()) return await outcome(stopReason()!, null);
      if (!headless.success) return await outcome("prompt_failed", headless.error ?? "wait_for_headless_completion failed without an error text.");
    }
    const last = await client.request({ type: "get_last_assistant_text", activeSessionId: sid }, 30_000);
    const after = readStats(await client.request({ type: "get_session_stats", activeSessionId: sid }, 30_000));
    const lastText = last.success && isObject(last.data) ? str(last.data.text) : null;
    return await outcome("completed", null, { lastText, statsDelta: delta(before, after) });
  } catch (err) {
    if (stopReason()) return await outcome(stopReason()!, null);
    if (err instanceof PrimeDaemonError) return await outcome("closed", `${terminalSessionError ?? err.message} Daemon stderr: ${daemon.stderrTail}`);
    throw err;
  } finally {
    stop?.dispose(); unsubscribe?.();
  }
}
function mapResult(o: Outcome, prep: PreparedRun, daemon: RunDaemon, clearSession: boolean): AdapterExecutionResult { const { runtime, seeded } = prep;
  const usage = o.statsDelta; const base: AdapterExecutionResult = { exitCode: 1, signal: null, timedOut: false,
    provider: runtime.provider, model: runtime.modelRef, biller: runtime.provider, billingType: seeded.billingType,
    ...(usage ? { usage: { inputTokens: usage.input, outputTokens: usage.output, cachedInputTokens: usage.cacheRead } } : {}), usageBasis: "per_run",
    costUsd: seeded.billingType === "api" && usage !== null && usage.cost > 0 ? usage.cost : null, resultJson: {
      stdout: o.stdout, stderr: daemon.stderrTail, runtime: "daemon", socketPath: daemon.socketPath, daemonPid: daemon.pid,
      activeSessionId: o.session?.activeSessionId ?? null, sessionStatsDelta: usage, parsedUsage: o.parsed.usage,
      autonomousStatus: o.autonomousStatus, cacheWriteTokens: usage?.cacheWrite ?? null, totalTokens: usage?.total ?? null, }, clearSession, };
  const fail = (errorCode: string, errorMessage: string): AdapterExecutionResult => ({ ...base, errorCode, errorMessage }); switch (o.stage) {
    case "timed_out": return { ...fail("prime_run_timeout", `Timed out after ${runtime.timeoutSec}s`), exitCode: null, timedOut: true };
    case "cancelled": return fail("prime_run_cancelled", "Run cancelled.");
    case "closed": return fail("prime_run_uncertain", `Prime daemon connection lost; the run outcome is uncertain. ${o.error}`); case "create_failed":
    case "prompt_failed": return fail("prime_run_failed", o.error ?? "Prime daemon run failed."); case "completed": break; }
  if (!o.parsed.sawAgentEnd) return fail("prime_run_uncertain", "The Prime daemon reported completion without an agent_end event; the run outcome is uncertain.");
  if (o.parsed.errors.length > 0) return fail("prime_run_failed", o.parsed.errors[0]!); const s = o.session!;
  const sessionParams: PrimeSessionParams = { sessionId: s.sessionId, sessionFile: s.sessionFile, cwd: prep.cwd,
    provider: runtime.provider, model: runtime.model, agentDir: runtime.agentDir.agentDir };
  return { ...base, exitCode: 0, errorCode: null, errorMessage: null, sessionId: s.sessionId, sessionParams: { ...sessionParams },
    sessionDisplayId: s.sessionId, summary: o.lastText ?? o.parsed.finalMessage }; }
export async function executeDaemon(input: {
  ctx: AdapterExecutionContext; prep: PreparedRun; native: PrimeNativeConfig; system: SystemPrompt; notes: string[];
  resumeSessionFile: string | null; userPrompt: (resumed: boolean) => string;
}): Promise<AdapterExecutionResult> {
  const { ctx, prep, native, system, notes, resumeSessionFile, userPrompt } = input;
if (native.subagentDefaultModel !== null) {
    const settingsFile = path.join(prep.runtime.agentDir.agentDir, "settings.json");
    const settings = (await readJsonObject(settingsFile)) ?? {};
    if (settings.subagentDefaultModel !== native.subagentDefaultModel) {
      await writePrivateJson(settingsFile, { ...settings, subagentDefaultModel: native.subagentDefaultModel });
    }
    notes.push(`settings.json subagentDefaultModel = ${native.subagentDefaultModel}.`);
  }
  if (prep.runtime.extraArgs.length > 0) await ctx.onLog("stdout", '[paperclip] extraArgs are ignored with runtime "daemon".\n');
  let daemon: RunDaemon;
  try { daemon = await startDaemon(ctx, prep); }
  catch (err) {
    if (!(err instanceof PrimeDaemonError)) throw err;
    return { exitCode: 1, signal: null, timedOut: false, errorCode: "prime_run_failed", errorMessage: err.message, clearSession: false };
  }
  try { return mapResult(await runAttempt(ctx, prep, native, system, notes, daemon, resumeSessionFile, userPrompt), prep, daemon, false); }
  finally { await daemon.stopDaemon(); }
}
