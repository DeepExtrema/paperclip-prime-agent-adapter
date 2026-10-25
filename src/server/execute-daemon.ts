import type {AdapterExecutionContext, AdapterExecutionResult} from "@paperclipai/adapter-utils";
import {spawn} from "node:child_process";
import {readFileSync} from "node:fs";
import {randomBytes} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";

import {type ParsedPrimeOutput, PRIME_ADAPTER_TYPE, type PrimeSessionParams} from "../types.js";

import { emitPrimeMeta, type PreparedRun, type SystemPrompt } from "./execute.js";
import type { ForeignGoal, GovernedRunState } from "./governed-run.js";
import { notePrimeChild, notePrimeParent, type PrimeAuditSources } from "./model-policy.js";
import {isPrimeUnknownSessionError, parsePrimeJsonl, primeProviderErrorCode} from "./parse.js";
import { PrimeSessionTracker, type PrimeTrackerViolation } from "./session-cap.js";
import { checkPrimeSkillList } from "./skill-list.js";
import { CATALOG_POLL_MS, confirmPrimeThinkingLevel, readPrimeCatalogProblem, waitForPrimeCatalog, type PrimeModelCatalogRecord } from "./model-catalog.js";

export type PrimeDaemonErrorCode =|"prime_daemon_start_failed"|"prime_daemon_socket_unsafe"|
  "prime_daemon_protocol_error"|"prime_daemon_closed"|"prime_daemon_request_timeout";

export class PrimeDaemonError extends Error {
  readonly code: PrimeDaemonErrorCode;
  constructor(code: PrimeDaemonErrorCode, message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = "PrimeDaemonError";
    this.code = code;
  }
}

export const PRIME_DAEMON_PROTOCOL = {
  name : "prime-agent.daemon",
  version : 7
} as const;
export function primeDaemonEnvelope(id: string, command: Record<string, unknown>) {
  return {type : "command", id, protocol : PRIME_DAEMON_PROTOCOL, command};
}

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
        if (!client.helloMessage) reject(client.closedError!); });
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
    if (this.closedError) return Promise.reject(this.closedError); const id = `pc-${++this.nextId}`;
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
    if (this.closedError) return; this.closedError = new PrimeDaemonError("prime_daemon_closed", message);
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer); this.pending.delete(id);
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
      if (typeof message !== "object" || message === null) continue; let wire = message as PrimeDaemonMessage;
      if (wire.type === "event" && typeof wire.event === "object" && wire.event !== null) wire = wire.event as PrimeDaemonMessage;
      if (wire.type === "daemon_hello" && !this.helloMessage) {
        this.helloMessage = wire;
        onHello();
        continue;
      }
      const pending = wire.type === "response" && typeof wire.id === "string" ? this.pending.get(wire.id) : undefined;
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer); this.pending.delete(wire.id as string);
        pending.resolve(wire as unknown as PrimeDaemonResponse);
        continue;
      }
      for (const listener of this.listeners) listener(wire);
    }
  }
}
const isUnset = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const trimmedText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const rawText = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
export class PrimeNativeConfigError extends Error {
  readonly code = "prime_native_config_invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "PrimeNativeConfigError";
  }
}

export interface PrimeNativeAutonomousConfig {
  enabled: true;
  maxTurns: number | null;
  maxTokens: number | null;
  maxContinuations: number | null;
  timeoutMs: number | null;
  gates: {
    commands: string[];
    maxRetries: number | null;
    timeoutMs: number | null;
  };
}

export interface PrimeNativeConfig {
  runtime: "daemon" | "print";
  goal: {
    objective: string;
    tokenBudget: number | null;
  } | null;
  autonomous: PrimeNativeAutonomousConfig | null;
  rlmMaxDepth: number | null;
  subagentDefaultModel: string | null;
}

const AUTONOMOUS_LIMIT_KEYS = [
  "autonomousMaxTurns", "autonomousMaxTokens", "autonomousMaxContinuations", "autonomousTimeoutMs",
  "autonomousGates", "autonomousGateRetries", "autonomousGateTimeoutMs",
] as const;

/** Unset → null. Numbers and numeric strings (UI text) are accepted; anything else is an error. */
function integerKey(config: Record<string, unknown>, key: string, min: number): number | null {
  const value = config[key];
  if (isUnset(value)) return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new PrimeNativeConfigError(`adapterConfig.${key} must be an integer >= ${min}.`);
  }
  return parsed;
}

function booleanKey(config: Record<string, unknown>, key: string): boolean {
  const value = config[key];
  if (isUnset(value)) return false;
  if (typeof value !== "boolean") throw new PrimeNativeConfigError(`adapterConfig.${key} must be true or false.`);
  return value;
}

function gateCommands(value: unknown): string[] {
  if (isUnset(value)) return [];
  const list = typeof value === "string" ? value.split("\n") : Array.isArray(value) ? value : null;
  if (list === null || list.some((item) => typeof item !== "string")) {
    throw new PrimeNativeConfigError(
      "adapterConfig.autonomousGates must be a list of shell commands (or one command per line).",
    );
  }
  return (list as string[]).map((item) => item.trim()).filter(Boolean);
}

export function resolvePrimeNativeConfig(config: Record<string, unknown>): PrimeNativeConfig {
  const runtime = isUnset(config.runtime) ? "print" : config.runtime;
  if (runtime !== "daemon" && runtime !== "print") {
    throw new PrimeNativeConfigError('adapterConfig.runtime must be "print" or "daemon".');
  }
  if (!isUnset(config.goal) && typeof config.goal !== "string") {
    throw new PrimeNativeConfigError("adapterConfig.goal must be a string.");
  }
  const objective = rawText(config.goal);
  const tokenBudget = integerKey(config, "goalTokenBudget", 1);
  if (objective === null && tokenBudget !== null) {
    throw new PrimeNativeConfigError("adapterConfig.goalTokenBudget needs adapterConfig.goal.");
  }
  const autonomousOn = booleanKey(config, "autonomous");
  if (!autonomousOn && AUTONOMOUS_LIMIT_KEYS.some((key) => !isUnset(config[key]))) {
    throw new PrimeNativeConfigError("adapterConfig.autonomous* limits need adapterConfig.autonomous: true.");
  }
  const autonomous: PrimeNativeAutonomousConfig | null = autonomousOn
    ? {
        enabled: true,
        maxTurns: integerKey(config, "autonomousMaxTurns", 1),
        maxTokens: integerKey(config, "autonomousMaxTokens", 1),
        maxContinuations: integerKey(config, "autonomousMaxContinuations", 1),
        timeoutMs: integerKey(config, "autonomousTimeoutMs", 1),
        gates: {
          commands: gateCommands(config.autonomousGates),
          maxRetries: integerKey(config, "autonomousGateRetries", 1),
          timeoutMs: integerKey(config, "autonomousGateTimeoutMs", 1),
        },
      }
    : null;
  if (!isUnset(config.subagentDefaultModel) && typeof config.subagentDefaultModel !== "string") {
    throw new PrimeNativeConfigError("adapterConfig.subagentDefaultModel must be a string in provider/modelId form.");
  }
  const subagentDefaultModel = trimmedText(config.subagentDefaultModel);
  if (subagentDefaultModel !== null) {
    const slash = subagentDefaultModel.indexOf("/");
    if (slash <= 0 || slash === subagentDefaultModel.length - 1) {
      throw new PrimeNativeConfigError("adapterConfig.subagentDefaultModel must be provider/modelId.");
    }
  }
  if (runtime === "print" && (objective !== null || autonomous !== null)) {
    throw new PrimeNativeConfigError('adapterConfig.goal and adapterConfig.autonomous need runtime "daemon".');
  }
  return {
    runtime,
    goal: objective === null ? null : { objective, tokenBudget },
    autonomous,
    rlmMaxDepth: integerKey(config, "rlmMaxDepth", 0),
    subagentDefaultModel,
  };
}
export function primeDaemonSocketPlan(childEnv: Record<string, string | undefined>, userId = process.getuid?.() ?? 0) {
  const env =
    Object.fromEntries(Object.entries(childEnv).filter((entry): entry is[string, string] => entry[1] !== undefined));
  if (Buffer.byteLength(env.TMPDIR ?? "/tmp") + 55 > 100) env.TMPDIR = `/tmp/paperclip-prime-${userId}/tmp`;
  const socketPath =
    path.join(env.TMPDIR ?? "/tmp", `paperclip-prime-${userId}`, `${randomBytes(8).toString("hex")}.sock`);
  if (Buffer.byteLength(socketPath) > 100)
    throw new PrimeDaemonError("prime_daemon_socket_unsafe",
                               `Daemon socket path is longer than 100 bytes: ${socketPath}`);
  return {env, socketPath};
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** A live process; a zombie (state Z) is not alive. */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z"; } catch { return true; }
}
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
}
type RunDaemon = {
  pid: number; socketPath: string; stderrTail: string; client: PrimeDaemonClient;
  workers: Set<number>; stopDaemon: () => Promise<void>;
};
/**
 * Daemon roster rows below the parent are children; their session files feed the model audit. With allowedModels set,
 * every session other than the parent is a source, depth 0 included (TAI-273 §2.2 item 2, rlm.create_session).
 */
function noteRosterChildren(sources: PrimeAuditSources | undefined, rows: unknown[]) {
  for (const row of rows) {
    if (!sources || !isObject(row) || typeof row.rlmDepth !== "number") continue;
    const seen = str(row.sessionId);
    if (seen) sources.seenSessionIds.add(seen); // §4.3 item 5, any depth
    const id = str(row.activeSessionId);
    if (!id) continue;
    if (row.rlmDepth <= 0 && (!sources.includeTopLevel || str(row.sessionId) === sources.parent?.sessionId)) continue;
    notePrimeChild(sources, id, { sessionFile: str(row.sessionFile), depth: row.rlmDepth });
  }
}
export async function startDaemon(ctx: AdapterExecutionContext, prep: PreparedRun, sources?: PrimeAuditSources): Promise<RunDaemon> {
  const { env, socketPath } = primeDaemonSocketPlan(prep.childEnv);
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  if (env.TMPDIR && env.TMPDIR !== prep.childEnv.TMPDIR) {
    await fs.mkdir(env.TMPDIR, { recursive: true, mode: 0o700 });
  }
  const child = spawn(prep.runtime.command, ["--mode", "daemon", "--daemon-socket", socketPath], {
    cwd: prep.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  let exitCode: number | null = null;
  let stderrTail = "";
  let spawnError: Error | null = null;
  let client: PrimeDaemonClient | null = null;
  const workers = new Set<number>();
  const exit = new Promise<void>(resolve => {
    child.once("exit", code => { exited = true; exitCode = code; client?.close(); resolve(); });
    child.once("error", err => { spawnError = err; exited = true; resolve(); });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-2000);
    void ctx.onLog("stderr", text);
  });
  const stopDaemon = async () => {
    try {
      if (!exited) {
        const shutdownClient = client?.closed
          ? await PrimeDaemonClient.connect(socketPath, 1000).catch(() => null) : client;
        const roster = await shutdownClient?.request({ type: "list" }, 1000).catch(() => null);
        if (roster?.success && isObject(roster.data) && Array.isArray(roster.data.sessions)) {
          for (const row of roster.data.sessions) {
            if (isObject(row) && typeof row.workerPid === "number") workers.add(row.workerPid);
          }
          noteRosterChildren(sources, roster.data.sessions);
        }
        await shutdownClient?.request({ type: "shutdown" }, 1000).catch(() => undefined);
        shutdownClient?.close();
        await Promise.race([exit, delay(5000)]);
        if (!exited) {
          for (const pid of [child.pid!, ...workers]) signalGroup(pid, "SIGTERM");
          await Promise.race([exit, delay(prep.runtime.graceSec * 1000)]);
          for (const pid of workers) signalGroup(pid, "SIGKILL");
          if (!exited) { signalGroup(child.pid!, "SIGKILL"); await exit; }
          workers.clear();
        }
      }
      // TAI-273 §4.3 item 5: workers lead their own process group (N0 item 13), so a daemon exit alone may not reach them.
      const alive = () => [...workers].filter(isAlive);
      if (exited && alive().length > 0) {
        for (const pid of alive()) signalGroup(pid, "SIGTERM");
        for (const until = Date.now() + prep.runtime.graceSec * 1000; alive().length > 0 && Date.now() < until;) await delay(50);
        for (const pid of alive()) signalGroup(pid, "SIGKILL");
      }
    } finally { client?.close(); await fs.rm(socketPath, { force: true }); }
  };
  try {
    if (child.pid) await ctx.onSpawn?.({ pid: child.pid, processGroupId: child.pid, startedAt: new Date().toISOString() });
    const until = Date.now() + 20_000;
    while (!exited && Date.now() < until) {
      try { client = await PrimeDaemonClient.connect(socketPath, 1000); break; }
      catch { await delay(50); }
    }
    if (!client || exited) {
      throw new PrimeDaemonError("prime_daemon_start_failed",
        `prime-agent daemon did not start (exit ${exitCode}). stderr: ${stderrTail} ${String(spawnError ?? "")}`);
    }
    return { pid: child.pid!, socketPath, get stderrTail() { return stderrTail; }, client, workers, stopDaemon };
  } catch (err) { await stopDaemon(); throw err; }
}
type Stage = "create_failed" | "prompt_failed" | "completed" | "closed" | "timed_out" | "cancelled" | "policy_failed" | "session_busy" | "skill_list_failed" | "catalog_failed";
type StatsDelta = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number };
type SessionSummary = { activeSessionId: string; sessionId: string; sessionFile: string; provider: string | null; model: string | null; thinkingLevel: string | null };
type Outcome = {
  stage: Stage; error: string | null; stdout: string; parsed: ParsedPrimeOutput; session: SessionSummary | null;
  lastText: string | null; statsDelta: StatsDelta | null; autonomousStatus: unknown; usageNote?: string;
  violation?: PrimeTrackerViolation;
};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
/** The daemon's errorInfo.code (0.10.1 DaemonErrorInfo, for example session_already_active), else null. */
const errorInfoCode = (response: PrimeDaemonResponse): string | null =>
  isObject((response as unknown as Record<string, unknown>).errorInfo) ? str(((response as unknown as Record<string, unknown>).errorInfo as Record<string, unknown>).code) : null;

function readSummary(data: unknown): SessionSummary | null {
  if (!isObject(data)) return null;
  const [activeSessionId, sessionId, sessionFile] = [str(data.activeSessionId), str(data.sessionId), str(data.sessionFile)];
  if (!activeSessionId || !sessionId || !sessionFile) return null; const model = isObject(data.model) ? data.model : {};
  return { activeSessionId, sessionId, sessionFile, provider: str(model.provider), model: str(model.id), thinkingLevel: str(data.thinkingLevel) };
}

function readStats(response: PrimeDaemonResponse | null): StatsDelta | null {
  const data = response?.success ? response.data : null;
  if (!isObject(data) || !isObject(data.tokens)) return null; const t = data.tokens;
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return { input: n(t.input), output: n(t.output), cacheRead: n(t.cacheRead), cacheWrite: n(t.cacheWrite), total: n(t.total), cost: n(data.cost) };
}

function delta(before: StatsDelta | null, after: StatsDelta | null): StatsDelta | null {
  if (!before || !after) return null;
  return { input: after.input - before.input, output: after.output - before.output, cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite, total: after.total - before.total, cost: after.cost - before.cost };
}

function createConfig(prep: PreparedRun, native: PrimeNativeConfig, system: SystemPrompt): Record<string, unknown> {
  const { runtime, cwd } = prep;
  const a = native.autonomous;
  const set = <T>(key: string, value: T | null) => (value === null ? {} : { [key]: value });
  return {
    cwd, agentDir: runtime.agentDir.agentDir, sessionDir: runtime.agentDir.sessionDir, provider: runtime.provider, model: runtime.model,
    ...set("thinking", runtime.thinking),
    appendSystemPrompt: [system.text, runtime.appendSystemPrompt ?? ""].filter((text) => text.trim().length > 0),
    skills: [...prep.skills.skillDirs, ...prep.builtinSkillDirs], // TAI-273 §2.2 item 10: governed-v1 adds the allowlisted built-ins
    ...(runtime.noContextFiles ? { noContextFiles: true } : {}),
    ...(a ? { autonomous: { enabled: true, ...set("maxTurns", a.maxTurns), ...set("maxTokens", a.maxTokens), ...set("maxContinuations", a.maxContinuations),
      ...set("timeoutMs", a.timeoutMs), gates: { commands: a.gates.commands, ...set("maxRetries", a.gates.maxRetries), ...set("timeoutMs", a.gates.timeoutMs) } } } : {}),
    ...(native.goal ? { initialGoal: { objective: native.goal.objective, ...set("tokenBudget", native.goal.tokenBudget) } } : {}),
    serializedRefine: true,
    telemetryDisabled: true,
  };
}

type StopReason = "cancelled" | "timed_out" | "policy";
function watchStop(ctx: AdapterExecutionContext, prep: PreparedRun, client: PrimeDaemonClient, activeSessionId: string) {
  let reason: StopReason | null = null;
  const timers: NodeJS.Timeout[] = [];
  const fire = (why: StopReason) => {
    if (reason) return; reason = why;
    void client.request({ type: "abort", activeSessionId }, 1000).catch(() => undefined);
    timers.push(setTimeout(() => client.close(), prep.runtime.graceSec * 1000));
  };
  const onAbort = () => fire("cancelled");
  if (ctx.signal?.aborted) fire("cancelled"); ctx.signal?.addEventListener("abort", onAbort, { once: true });
  if (prep.deadlineMs !== null) timers.push(setTimeout(() => fire("timed_out"), Math.max(1, prep.deadlineMs - Date.now())));
  return { reason: () => reason, fire, dispose: () => {
    ctx.signal?.removeEventListener("abort", onAbort);
    for (const timer of timers) clearTimeout(timer);
  } };
}

/** TAI-273 §2.2 item 7: the newest thread_goal_state entry, and how many successful `/goal clear` results the file holds. */
async function readGoalState(sessionFile: string): Promise<{ goal: Record<string, unknown> | null; clears: number }> {
  let text = "";
  try { text = await fs.readFile(sessionFile, "utf8"); } catch { return { goal: null, clears: 0 }; }
  let goal: Record<string, unknown> | null = null;
  let clears = 0;
  for (const line of text.split("\n")) {
    if (!line.includes("thread_goal_state") && !line.includes("session_slash_command_result")) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isObject(entry)) continue;
    if (entry.type === "custom" && entry.customType === "thread_goal_state" && isObject(entry.data)) goal = entry.data;
    const command = isObject(entry.details) && isObject(entry.details.command) ? entry.details.command : null;
    if (entry.type === "custom_message" && entry.customType === "session_slash_command_result" && command?.name === "goal"
      && command.args === "clear" && isObject(entry.details) && entry.details.success === true) clears += 1;
  }
  return { goal, clears };
}
function pendingStop(ctx: AdapterExecutionContext, prep: PreparedRun): StopReason|null {
  if (ctx.signal?.aborted) return "cancelled";
  return prep.deadlineMs !== null && Date.now() >= prep.deadlineMs ? "timed_out" : null;
}
async function runAttempt(
  ctx: AdapterExecutionContext,
  prep: PreparedRun,
  native: PrimeNativeConfig,
  system: SystemPrompt,
  notes: string[],
  daemon: RunDaemon,
  resumeSessionFile: string | null,
  userPrompt: (resumed: boolean) => string,
  sources: PrimeAuditSources,
  governed: GovernedRunState | null,
  ): Promise<Outcome> {
  const {runtime, cwd} = prep;
  let stdout = "";
  let logChain = Promise.resolve();
  const emit = (line: string) => {
    stdout += line;
    logChain = logChain.then(() => ctx.onLog("stdout", line));
  };
  let session: SessionSummary | null = null;
  let autonomousStatus: unknown = null;
  const childIds = new Set<string>();
  const childStatus = new Map<string, { status: string; snapshotAfter: number }>();
  let rosterRequests = 0;
  let childUsageMissing = false;
  let terminalSessionError: string | null = null;
  let prompted = false;
  let stop: ReturnType<typeof watchStop>|null = null;
  let tracker: PrimeSessionTracker | null = null;
  let violation: PrimeTrackerViolation | null = null;
  // TAI-273 §2.2 item 12: set once the pre-prompt check passed; catalogParent once the run is live.
  let catalog: PrimeModelCatalogRecord | null = null;
  let catalogParent: string | null = null;
  let catalogPoll: NodeJS.Timeout | null = null;
  let catalogChecking: Promise<void> | null = null;
  /** During the run, a failed check aborts the turn, and the run fails with no clearSession (the daemon stops in executeDaemon). */
  const recheckCatalog = (): Promise<void> => {
    if (!catalog || !catalog.ok || catalogParent === null || violation) return Promise.resolve();
    const parent = catalogParent;
    catalogChecking ??= (async () => {
      catalog!.checks += 1;
      const problem = await readPrimeCatalogProblem(daemon.client, parent, prep.policy.allowedModels ?? [], prep.runtime.thinking);
      if (!problem || violation) return;
      catalog!.ok = false;
      catalog!.failure = problem;
      violation = { code: "prime_model_catalog_invalid", message: `Prime model catalog check failed: ${problem}` };
      emit(`[paperclip] ${violation.message}\n`);
      stop?.fire("policy");
    })().finally(() => { catalogChecking = null; });
    return catalogChecking;
  };
  const stopReason = (): StopReason | null => (violation ? "policy" : null) ?? stop?.reason() ?? pendingStop(ctx, prep);
  const outcome = async(stage: Stage | StopReason, error: string | null, extra: Partial<Outcome> = {}): Promise<Outcome> => {
    await logChain;
    const reason = stopReason();
    if (reason === "policy") {
      stage = "policy_failed";
      extra = { ...extra, violation: violation! };
    } else if (reason) {
      stage = reason;
    } else if (stage === "policy") {
      stage = "policy_failed";
    } else if (stage === "completed" && terminalSessionError !== null) {
      stage = "closed";
      error = `${terminalSessionError} Daemon stderr: ${daemon.stderrTail}`;
    }
    return {
      stage: stage as Stage,
      error,
      stdout,
      parsed : parsePrimeJsonl(stdout),
      session,
      lastText : null,
      statsDelta : null,
      autonomousStatus,
      ...extra
    };
  };
  if (stopReason()) return await outcome(stopReason()!, null);
  const client = daemon.client;
  let unsubscribe: (() => void)|null = null;
  try {
    const config = createConfig(prep, native, system);
    let selectedId: string | null = null;
    const closeSelected = (id: string, reason: string) => {
      terminalSessionError = `Prime session ${id} closed (${reason}).`;
      client.close(); // Reject local waits only; no session/daemon command.
    };
    unsubscribe = client.onMessage((message) => {
      // TAI-273 §2.2 item 2: roster_update {changed, removed, resync} feeds the session cap (N0 item 5).
      if (message.type === "roster_update") {
        if (Array.isArray(message.changed)) tracker?.ingest(message.changed);
        if (message.resync === true) void tracker?.list();
      } else if (message.type === "session_binding") void tracker?.list();
      // TAI-273 §2.2 item 12: a catalog refresh during the run (the event needs roster_subscribe; TAI-339).
      if (message.type === "model_catalog_changed" || (message.type === "event" && isObject(message.event) && message.event.type === "model_catalog_changed")) {
        if (catalog) catalog.refreshesSeen += 1;
        void recheckCatalog();
      }
      if (message.type === "session_event" && isObject(message.event) && message.event.type === "rlm_child_update" &&
          isObject(message.event.child)) {
        const childId = str(message.event.child.activeSessionId);
        if (childId && tracker && !childIds.has(childId)) void tracker.list();
        if (childId) {
          childIds.add(childId);
          const depth = message.event.child.rlmDepth;
          notePrimeChild(sources, childId, { sessionFile: str(message.event.child.sessionFile), depth: typeof depth === "number" ? depth : null });
          const previous = childStatus.get(childId);
          const status = str(message.event.child.status) ?? "running";
          childStatus.set(childId, { status, snapshotAfter: previous?.status === status
            ? previous.snapshotAfter : rosterRequests + 1 });
        }
        else
          childUsageMissing = true;
      }
      const id = str(message.activeSessionId);
      if (message.type === "session_closed" && id) {
        const reason = str(message.reason) ?? "no reason supplied";
        if (selectedId === id) closeSelected(id, reason);
      } else if (selectedId === id && message.type === "session_event" && isObject(message.event))
        emit(`${JSON.stringify(message.event)}\n`);
    });
    // TAI-273 §2.2 item 7: a goal Paperclip did not set is read from the session file before create.
    const savedGoal = governed && resumeSessionFile ? (await readGoalState(resumeSessionFile)).goal : null;
    const foreign = savedGoal && (savedGoal.status === "active" || savedGoal.status === "paused")
      && savedGoal.objective !== native.goal?.objective ? savedGoal : null;
    const createSession = async (sessionPath: string | null): Promise<SessionSummary | { error: string; code: string | null }> => {
      const created = await client.request({ type: "create", lifecycle: "resident", config, ...(sessionPath ? { sessionPath } : {}) }, 60_000);
      const summary = created.success ? readSummary(created.data) : null;
      if (!summary) return { error: created.error ?? `Unexpected create response: ${JSON.stringify(created).slice(0, 300)}`, code: errorInfoCode(created) };
      if (isObject(created.data) && typeof created.data.workerPid === "number") daemon.workers.add(created.data.workerPid);
      notePrimeParent(sources, { sessionId: summary.sessionId, sessionFile: summary.sessionFile });
      return summary;
    };
    const setUp = async (summary: SessionSummary) => {
      const must = async (command: Record<string, unknown>&{type : string}) => {
        const response = await client.request({...command, activeSessionId : summary.activeSessionId}, 30_000);
        if (!response.success)
          throw new PrimeDaemonError("prime_daemon_protocol_error",
                                     `${command.type} failed: ${response.error ?? "no error text"}`);
        return response;
      };
      if (summary.provider !== runtime.provider || summary.model !== runtime.model)
        await must({type : "set_model", provider : runtime.provider, modelId : runtime.model});
      // Under governed-v1 this write is harmless: defaultThinkingLevel is a managed key with this value (rev 11, item 1).
      if (runtime.thinking !== null && summary.thinkingLevel !== runtime.thinking)
        await must({type : "set_thinking_level", level : runtime.thinking});
      if (native.rlmMaxDepth !== null) await must({type : "set_rlm_max_depth", maxDepth : native.rlmMaxDepth});
    };
    const explicitDirs = [...prep.skills.skillDirs, ...prep.builtinSkillDirs];
    // TAI-273 §2.2 item 10: the parent's own skill list, before any prompt (and again for item 7's fresh session).
    const checkParent = async (summary: SessionSummary): Promise<string | null> => {
      if (!governed) return null;
      const check = await checkPrimeSkillList(client, summary.activeSessionId, explicitDirs, true);
      if (!check.ok) return `Prime session ${summary.sessionId} skill list check failed: ${check.reason}`;
      governed.live.skillDiscovery = "off";
      governed.live.contextFiles = check.contextFiles;
      return null;
    };
    // TAI-273 §2.2 item 12: the allowed models in the catalog, and the parent's thinking level, before the first prompt.
    const allowedModels = prep.policy.allowedModels ?? [];
    const confirmThinking = async (summary: SessionSummary): Promise<string | null> =>
      (catalog && runtime.thinking !== null ? await confirmPrimeThinkingLevel(client, summary.activeSessionId, `${runtime.provider}/${runtime.model}`, runtime.thinking, catalog) : null);
    const catalogFailed = (problem: string) => {
      catalog!.ok = false;
      catalog!.failure = problem;
      const message = `Prime model catalog check failed: ${problem}`;
      emit(`[paperclip] ${message}\n`);
      return message;
    };
    let first = await createSession(resumeSessionFile);
    let resumed = resumeSessionFile !== null;
    if ("error" in first && resumeSessionFile) {
      const id = path.basename(resumeSessionFile, ".jsonl");
      // TAI-273 §4.3 item 2: a held lease means a process from an earlier run is alive; fail and keep the row.
      if (first.code === "session_already_active" || /currently open in another/i.test(first.error)) {
        const pid = /\bpid\D{0,3}(\d+)/i.exec(first.error)?.[1];
        emit(`[paperclip] Prime session ${id} is held by another process${pid ? ` (pid ${pid})` : ""}; not starting.\n`);
        return await outcome("session_busy", first.error);
      }
      // §4.3 item 1: a missing or unknown session file starts one fresh session, returned without clearSession.
      if (first.code === "session_import_file_not_found" || isPrimeUnknownSessionError("", first.error) || /no such file|not found|does not exist/i.test(first.error)) {
        emit(`[paperclip] Prime session ${id} is unavailable (${first.error}); starting a fresh session.\n`);
        first = await createSession(null);
        resumed = false;
      }
    }
    if ("error" in first) return await outcome("create_failed", first.error);
    session = first;
    await setUp(session);
    const parentProblem = await checkParent(session);
    if (parentProblem) {
      emit(`[paperclip] ${parentProblem}\n`);
      return await outcome("skill_list_failed", parentProblem, { session: null });
    }
    if (governed) {
      catalog = governed.live.modelCatalog = { ok: false, checks: 0, refreshesSeen: 0, liveModel: null, thinkingLevel: null, failure: null };
      const problem = await waitForPrimeCatalog(client, session.activeSessionId, allowedModels, runtime.thinking, catalog)
        ?? await confirmThinking(session);
      if (problem) return await outcome("catalog_failed", catalogFailed(problem), { session: null });
      catalog.ok = true;
    }
    if (foreign && governed) {
      const record: ForeignGoal = { goalId: str(foreign.goalId), objective: String(foreign.objective ?? "").slice(0, 200), status: String(foreign.status), action: "cleared" };
      governed.live.foreignGoals.push(record);
      const before = await readGoalState(session.sessionFile);
      const answer = await client.request({ type: "prompt_and_wait", activeSessionId: session.activeSessionId, message: "/goal clear", queueIfBusy: false }, 60_000);
      const after = await readGoalState(session.sessionFile);
      if (!answer.success || after.clears <= before.clears || after.goal?.active !== false) {
        record.action = "fresh_session";
        emit(`[paperclip] Prime session ${session.sessionId} holds a goal not set by Paperclip; starting a fresh session.\n`);
        await client.request({ type: "kill", activeSessionId: session.activeSessionId }, 30_000);
        const fresh = await createSession(null);
        if ("error" in fresh) return await outcome("create_failed", fresh.error);
        session = fresh;
        await setUp(session);
        resumed = false;
        const freshProblem = await checkParent(session);
        if (freshProblem) {
          emit(`[paperclip] ${freshProblem}\n`);
          return await outcome("skill_list_failed", freshProblem, { session: null });
        }
        const thinkingProblem = await confirmThinking(session);
        if (thinkingProblem) return await outcome("catalog_failed", catalogFailed(thinkingProblem), { session: null });
      }
    }
    const sid = session.activeSessionId;
    selectedId = sid;
    const must = async (command: Record<string, unknown>&{type : string}) => {
      const response = await client.request({...command, activeSessionId : sid}, 30_000);
      if (!response.success)
        throw new PrimeDaemonError("prime_daemon_protocol_error",
                                   `${command.type} failed: ${response.error ?? "no error text"}`);
      return response;
    };
    emit(`${
      JSON.stringify(
        {type : "session", version : 3, id : session.sessionId, timestamp : new Date().toISOString(), cwd, model : `${runtime.provider}/${runtime.model}`})}\n`);
    await must({type : "attach"});
    if (governed) {
      // TAI-273 §2.2 item 2: count and cap every other session; the item 1 isQuotaParked backstop.
      const parentRef = { activeSessionId: sid, sessionId: session.sessionId };
      tracker = new PrimeSessionTracker({
        client, parent: parentRef, cap: governed.profile.maxSubagentsPerRun,
        onViolation: (found) => {
          violation = found;
          emit(`[paperclip] ${found.message}\n`);
          stop?.fire("policy");
        },
        onLog: (line) => emit(line),
        onRow: (row) => {
          if (row.workerPid !== null) daemon.workers.add(row.workerPid);
          if (row.sessionId !== parentRef.sessionId) notePrimeChild(sources, row.activeSessionId, { sessionFile: row.sessionFile, depth: row.depth });
        },
        checkSession: (row) => checkPrimeSkillList(client, row.activeSessionId, explicitDirs, false),
        onWarning: (text) => governed.live.warnings.push(text),
      });
      await tracker.start();
      catalogParent = sid;
      if (tracker.polling) catalogPoll = setInterval(() => void recheckCatalog(), CATALOG_POLL_MS);
    }
    const prompt = userPrompt(resumed);
    await emitPrimeMeta(ctx, prep, system,
      [...notes, `Prime daemon pid ${daemon.pid} (per run), socket ${daemon.socketPath}, session ${session.sessionId}.`],
      ["--mode", "daemon", "--daemon-socket", daemon.socketPath], prompt);
    const before = readStats(await client.request({type : "get_session_stats", activeSessionId : sid}, 30_000));
    if (stopReason()) return await outcome(stopReason()!, null);
    stop = watchStop(ctx, prep, client, sid);
    if (stopReason()) return await outcome(stopReason()!, null);
    prompted = true;
    notePrimeParent(sources, { prompted: true });
    const promptResponse = await client.request(
      {type : "prompt_and_wait", activeSessionId : sid, message : prompt, queueIfBusy : false}, null);
    if (stopReason()) return await outcome(stopReason()!, null);
    if (!promptResponse.success) {
      const error = promptResponse.error ?? "prompt_and_wait failed without an error text.";
      return await outcome("prompt_failed", error);
    }
    {
      const headless = await client.request({type : "wait_for_headless_completion", activeSessionId : sid}, null);
      autonomousStatus = headless.success ? headless.data ?? null : {error : headless.error ?? null};
      if (stopReason()) return await outcome(stopReason()!, null);
      if (!headless.success)
        return await outcome("prompt_failed",
                             headless.error ?? "wait_for_headless_completion failed without an error text.");
    }
    for (;;) {
      const snapshot = ++rosterRequests;
      const listed = await client.request({type : "list"}, 30_000);
      const rows = listed.success && isObject(listed.data) && Array.isArray(listed.data.sessions)
                     ? listed.data.sessions.filter(isObject)
                     : null;
      if (!rows) return await outcome("prompt_failed", listed.error ?? "Unexpected daemon list response.");
      for (const row of rows) if (typeof row.workerPid === "number") daemon.workers.add(row.workerPid);
      noteRosterChildren(sources, rows);
      tracker?.ingest(rows);
      for (const row of rows) {
        if (typeof row.rlmDepth === "number" && row.rlmDepth > 0) {
          const id = str(row.activeSessionId);
          if (id) childIds.add(id);
          else childUsageMissing = true;
        }
      }
      const parent = rows.find(row => row.activeSessionId === sid);
      if (!parent) return await outcome("prompt_failed", "Parent session missing from daemon list.");
      const actions = isObject(parent.sessionActions) ? parent.sessionActions : {};
      // A child the session cap ended may never report a final status (TAI-273 §2.2 item 2).
      const childrenPending = parent.hasRunningSubagents === true || [...childStatus.entries()].some(([id, child]) => !tracker?.isEnded(id) &&
        (!["done", "completed", "error", "cancelled"].includes(child.status) || snapshot < child.snapshotAfter));
      const busy = childrenPending || parent.isSessionActive === true || parent.isStreaming === true ||
                   parent.isRunningTools === true || parent.isBashRunning === true ||
                   Number(actions.queuedCount ?? 0) > 0;
      if (stopReason()) {
        const last =
          await client.request({type : "get_last_assistant_text", activeSessionId : sid}, 1000).catch(() => null);
        const text = last?.success && isObject(last.data) ? str(last.data.text) : null;
        return await outcome(stopReason()!,
                             `${text ?? ""}${childrenPending ? " children still running at timeout" : ""}`.trim());
      }
      if (!busy) break; await delay(250);
    }
    await tracker?.settle();
    if (tracker?.polling) await recheckCatalog(); // item 12: once more after the last turn on the poll fallback
    if (stopReason()) return await outcome(stopReason()!, null);
    const last = await client.request({type : "get_last_assistant_text", activeSessionId : sid}, 30_000);
    const after = readStats(await client.request({type : "get_session_stats", activeSessionId : sid}, 30_000));
    const statsDelta = delta(before, after);
    if (statsDelta) notePrimeParent(sources, { tokens: statsDelta.total });
    for (const childId of childIds) {
      const childResponse = await client.request({type : "get_session_stats", activeSessionId : childId}, 30_000).catch(() => null);
      const childStats = readStats(childResponse);
      notePrimeChild(sources, childId, { tokens: childStats?.total ?? null,
        sessionFile: childResponse?.success && isObject(childResponse.data) ? str(childResponse.data.sessionFile) : null });
      if (statsDelta && childStats) {
        for (const key of Object.keys(statsDelta) as (keyof StatsDelta)[])
          statsDelta[key] += childStats[key];
      } else
        childUsageMissing = true;
    }
    const lastText = last.success && isObject(last.data) ? str(last.data.text) : null;
    return await outcome(
      "completed", null,
      { lastText, statsDelta, usageNote: childUsageMissing ? "child usage not reported" : undefined });
  } catch (err) {
    if (stopReason()) return await outcome(stopReason()!, null);
    if (err instanceof PrimeDaemonError) {
      const uncertain = prompted && err.code === "prime_daemon_closed";
      return await outcome(uncertain ? "closed" : "prompt_failed",
                           `${terminalSessionError ?? err.message} Daemon stderr: ${daemon.stderrTail}`);
    }
    throw err;
  } finally {
    stop?.dispose();
    if (catalogPoll) clearInterval(catalogPoll);
    catalogParent = null;
    unsubscribe?.();
    tracker?.dispose();
    if (governed && tracker) {
      governed.live.sessions = tracker.sessions;
      governed.live.sessionsEnded = tracker.sessionsEnded;
      governed.live.sessionSkillChecks = tracker.sessionSkillChecks;
    }
  }
}
function mapResult(o: Outcome, prep: PreparedRun, daemon: RunDaemon, clearSession: boolean): AdapterExecutionResult {
  const { runtime, seeded } = prep;
  const usage = o.statsDelta;
  const base: AdapterExecutionResult = {
    exitCode: 1, signal: null, timedOut: false,
    provider: runtime.provider, model: runtime.modelRef, biller: runtime.provider, billingType: seeded.billingType,
    ...(usage ? { usage: { inputTokens: usage.input, outputTokens: usage.output, cachedInputTokens: usage.cacheRead } } : {}),
    usageBasis: "per_run",
    costUsd: seeded.billingType === "api" && usage !== null && usage.cost > 0 ? usage.cost : null,
    resultJson: {
      stdout: o.stdout, stderr: daemon.stderrTail, runtime: "daemon", socketPath: daemon.socketPath, daemonPid: daemon.pid,
      activeSessionId: o.session?.activeSessionId ?? null, sessionStatsDelta: usage, parsedUsage: o.parsed.usage, usageNote: o.usageNote,
      autonomousStatus: o.autonomousStatus, cacheWriteTokens: usage?.cacheWrite ?? null, totalTokens: usage?.total ?? null,
    },
    clearSession,
  };
  const fail = (errorCode: string, errorMessage: string): AdapterExecutionResult => ({ ...base, errorCode, errorMessage });
  switch (o.stage) {
    case "policy_failed": return fail(o.violation!.code, o.violation!.message);
    case "session_busy": return { ...fail("prime_session_busy", o.error ?? "The Prime session is held by another process."),
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };
    case "skill_list_failed": return { ...fail("prime_skill_list_invalid", o.error ?? "The Prime skill list check failed."),
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };
    case "catalog_failed": return { ...fail("prime_model_catalog_invalid", o.error ?? "The Prime model catalog check failed."),
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false } };
    case "timed_out": return { ...fail("prime_run_timeout", `Timed out after ${runtime.timeoutSec}s${o.error ? `: ${o.error}` : ""}`), exitCode: null, timedOut: true };
    case "cancelled": return fail("prime_run_cancelled", "Run cancelled.");
    case "closed": return fail("prime_run_uncertain", `Prime daemon connection lost; the run outcome is uncertain. ${o.error}`);
    case "create_failed": return fail("prime_run_failed", o.error ?? "Prime daemon run failed.");
    case "prompt_failed": return fail(primeProviderErrorCode(o.stdout) ?? "prime_run_failed", o.error ?? "Prime daemon run failed.");
    case "completed": break;
  }
  if (!o.parsed.sawAgentEnd) return fail("prime_run_uncertain", "The Prime daemon reported completion without an agent_end event; the run outcome is uncertain.");
  if (o.parsed.errors.length > 0) return fail(primeProviderErrorCode(o.stdout) ?? "prime_run_failed", o.parsed.errors[0]!); const s = o.session!;
  const sessionParams: PrimeSessionParams = { sessionId: s.sessionId, sessionFile: s.sessionFile, cwd: prep.cwd,
    provider: runtime.provider, model: runtime.model, agentDir: runtime.agentDir.agentDir };
  return { ...base, exitCode: 0, errorCode: null, errorMessage: null, sessionId: s.sessionId, sessionParams: { ...sessionParams },
    sessionDisplayId: s.sessionId, summary: o.lastText ?? o.parsed.finalMessage };
}

export async function executeDaemon(input: {
  ctx: AdapterExecutionContext;
  prep : PreparedRun;
  native : PrimeNativeConfig;
  system : SystemPrompt;
  notes : string[];
  resumeSessionFile : string | null;
  userPrompt : (resumed: boolean) => string;
  sources : PrimeAuditSources;
  governed : GovernedRunState | null;
}): Promise<AdapterExecutionResult> {
  const {ctx, prep, native, system, notes, resumeSessionFile, userPrompt, sources, governed} = input;
  if (prep.runtime.extraArgs.length > 0)
    await ctx.onLog("stdout", '[paperclip] extraArgs are ignored with runtime "daemon".\n');
  // TAI-273 §7 item 9 (N0 item 16): the 0.10.1 daemon accepts noContextFiles in create and ignores it.
  if (prep.runtime.noContextFiles)
    await ctx.onLog("stdout", '[paperclip] warning: noContextFiles has no effect with runtime "daemon": Prime 0.10.1 still loads AGENTS.md and CLAUDE.md.\n');
  let daemon: RunDaemon;
  try {
    daemon = await startDaemon(ctx, prep, sources);
  } catch (err) {
    if (!(err instanceof PrimeDaemonError)) throw err;
    return {
      exitCode : 1,
      signal : null,
      timedOut : false,
      errorCode : "prime_run_failed",
      errorMessage : err.message,
      clearSession : false
    };
  }
  try {
    return mapResult(await runAttempt(ctx, prep, native, system, notes, daemon, resumeSessionFile, userPrompt, sources, governed), prep,
                     daemon, false);
  } finally {
    await daemon.stopDaemon();
  }
}
