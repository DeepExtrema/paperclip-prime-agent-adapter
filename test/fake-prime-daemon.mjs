#!/usr/bin/env node
// Test double for `prime-agent --mode daemon` 0.10.0 (WP9). It never calls a model.
// Wire shapes copied from the 2026-10-18 probes (plans/WP9-daemon-runtime.md §0.3).
// Also answers `--version` and `model list` like test/fake-prime-agent.mjs.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
const argv = process.argv.slice(2);
const env = process.env;
const record = (entry) => { if (env.FAKE_DAEMON_RECORD) appendFileSync(env.FAKE_DAEMON_RECORD, `${JSON.stringify({ pid: process.pid, ...entry })}\n`); };
if (argv[0] === "--version") {
  process.stdout.write(`${env.FAKE_PRIME_VERSION ?? "0.10.0"}\n`);
  process.exit(0);
}
if (argv[0] === "model" && argv[1] === "list") {
  process.stdout.write(readFileSync(env.FAKE_PRIME_MODEL_LIST, "utf8"));
  process.exit(0);
}
const socketPath = argv[argv.indexOf("--daemon-socket") + 1];
if (argv[0] !== "--mode" || argv[1] !== "daemon" || !socketPath) {
  process.stderr.write(`fake-prime-daemon: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exit(64);
}
record({ kind: "start", argv, cwd: process.cwd(), env });
let workerPid = process.pid;
if (env.FAKE_DAEMON_WORKER) {
  const worker = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  workerPid = worker.pid;
  record({ kind: "worker", workerPid });
}
if (env.FAKE_DAEMON_EXIT_AT_START === "1") {
  process.stderr.write("fake-prime-daemon: boom at start\n");
  process.exit(3);
}
if (env.FAKE_DAEMON_IGNORE_TERM === "1") process.on("SIGTERM", () => record({ kind: "sigterm_ignored" }));
else process.on("SIGTERM", () => shutdown());
const PROCESSING = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";
const sessions = new Map();
let nextSession = 0;
const clients = new Set();
// TAI-273 §2.2 item 2: roster_subscribe clients get roster_update {changed, removed} (N0 item 5).
const subscribers = new Set();
const rosterItem = (s) => ({ agentId: s.sessionId, summary: summary(s), status: s.prompted ? "live" : "idle", workerId: s.id });
const rosterChanged = (s) => { for (const c of subscribers) send(c, { type: "roster_update", changed: [rosterItem(s)] }); };
const rosterRemoved = (id) => { for (const c of subscribers) send(c, { type: "roster_update", changed: [], removed: [id] }); };
const send = (socket, message) => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); };
const eventsOf = () => (env.FAKE_DAEMON_EVENTS_FILE ? readFileSync(env.FAKE_DAEMON_EVENTS_FILE, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((e) => e.type !== "session") : []);
const usageOf = (events) => {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  for (const e of events) {
    const u = e.type === "turn_end" && e.message?.role === "assistant" ? e.message.usage : null;
    if (!u) continue;
    sum.input += u.input ?? 0; sum.output += u.output ?? 0; sum.cacheRead += u.cacheRead ?? 0;
    sum.cacheWrite += u.cacheWrite ?? 0; sum.total += u.totalTokens ?? 0; sum.cost += u.cost?.total ?? 0;
  }
  return sum;
};
const lastText = (events) => {
  for (const e of [...events].reverse()) {
    if (e.type === "message_end" && e.message?.role === "assistant") {
      return (e.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("") || null;
    }
  }
  return null;
};
function summary(s) {
  return { id: s.id, activeSessionId: s.id, lifecycle: s.prompted ? "live" : "draft", activity: s.streaming ? "working" : "idle",
    rlmDepth: s.depth ?? 0, sessionId: s.sessionId, sessionFile: s.sessionFile, cwd: s.cwd, thinkingLevel: s.thinking,
    model: { id: s.model, provider: s.provider }, isSessionActive: s.streaming, isStreaming: s.streaming, isCompacting: false, isBashRunning: false,
    hasRunningSubagents: s.childRunning || env.FAKE_DAEMON_SUBAGENTS_RUNNING === "1", attachedClients: s.clients.size, messageCount: s.messages, workerState: "ready", workerPid,
    isQuotaParked: s.quotaParked === true, ...(s.parentActive ? { parentActiveSessionId: s.parentActive } : {}), ...(s.rlmChildId ? { rlmChildId: s.rlmChildId } : {}),
    runtimeKind: (s.depth ?? 0) > 0 ? "subagent" : "top-level" };
}
function emit(s, event) {
  s.seq += 1;
  const message = { type: "session_event", activeSessionId: s.id, event, meta: { id: `${s.id}:${s.seq}`, sequence: s.seq } };
  const wire = env.FAKE_DAEMON_ENVELOPE_EVENTS === "1" ? { type: "event", id: `${s.id}:${s.seq}`, protocol: { name: "prime-agent.daemon", version: 7 }, event: message } : message;
  for (const c of s.clients) send(c, wire);
}
// TAI-225 §9 audit: Prime appends {"type":"message","message":{role,provider,model,...}} lines to the session file.
const appendTurn = (s, message) => appendFileSync(s.sessionFile, `${JSON.stringify({ type: "message", id: `m${s.seq}`, message })}\n`);
const mergeJson = (file, patch) => {
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, `${JSON.stringify({ ...current, ...patch })}\n`);
};
function create(command, depth = 0) {
  const config = command.config ?? {};
  const sessionPath = command.sessionPath;
  for (const s of sessions.values()) if (sessionPath && s.sessionFile === sessionPath) return s;
  if (sessionPath && env.FAKE_DAEMON_CREATE_ERROR) return env.FAKE_DAEMON_CREATE_ERROR;
  let sessionId = `fake-session-${process.pid}-${++nextSession}`;
  if (sessionPath && existsSync(sessionPath)) sessionId = JSON.parse(readFileSync(sessionPath, "utf8").split("\n")[0]).id;
  const sessionFile = sessionPath ?? path.join(config.sessionDir, `${sessionId}.jsonl`);
  if (!existsSync(sessionFile)) {
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: config.cwd, rlmDepth: depth })}\n`);
  }
  const initial = JSON.parse(env.FAKE_DAEMON_INITIAL_STATS ?? '{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0,"cost":0}');
  const s = { id: `a${process.pid.toString(16)}${++nextSession}`.slice(0, 12), sessionId, sessionFile, cwd: config.cwd, config,
    provider: env.FAKE_DAEMON_MODEL_PROVIDER ?? config.provider ?? "anthropic", model: env.FAKE_DAEMON_MODEL_ID ?? config.model ?? "claude-opus-4-7",
    thinking: config.thinking ?? "medium", streaming: env.FAKE_DAEMON_STREAMING_AT_START === "1", prompted: false, messages: 0, seq: 0,
    stats: initial, last: null, clients: new Set(), pending: null, rlmMaxDepth: 2 };
  sessions.set(s.id, s);
  return s;
}
// An ended session leaves the roster. FAKE_DAEMON_WAKE_ENDED_MS: the parent wakes it again later, under a new activeSessionId.
function endSession(s) {
  sessions.delete(s.id);
  rosterRemoved(s.id);
  if (env.FAKE_DAEMON_WAKE_ENDED_MS && s.depth !== undefined) setTimeout(() => {
    const woken = { ...s, id: `w${s.id}`.slice(0, 12), parentActive: null, streaming: true, clients: new Set() };
    sessions.set(woken.id, woken);
    rosterChanged(woken);
  }, Number(env.FAKE_DAEMON_WAKE_ENDED_MS));
}
// FAKE_DAEMON_SPAWN: JSON list of depths. Each entry is one more session started during the parent's turn, with one audited turn.
function spawnSessions(parent) {
  parent.spawned = [];
  for (const depth of JSON.parse(env.FAKE_DAEMON_SPAWN ?? "[]")) {
    const child = create({ config: parent.config }, depth);
    child.discovered = true; // a child or create_session session does its own discovery (N0 item 16, corrected)
    parent.spawned.push(child);
    child.depth = depth;
    child.running = true;
    if (depth > 0) { child.parentActive = parent.id; child.rlmChildId = `sub-${child.id}`; }
    appendTurn(child, { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop", provider: child.provider,
      model: env.FAKE_DAEMON_SPAWN_MODEL ?? child.model });
    rosterChanged(child);
    if (depth > 0) emit(parent, { type: "rlm_child_update", child: { activeSessionId: child.id, status: "running" } });
  }
}
function finishPrompt(s, events) {
  for (const e of events) emit(s, e);
  for (const e of events) {
    if (e.type === "message_end" && e.message?.role === "assistant") appendTurn(s, { ...e.message, provider: s.provider, model: s.model });
  }
  if (env.FAKE_DAEMON_PARENT_FILE_GONE === "1" && s.depth === undefined) rmSync(s.sessionFile, { force: true });
  const u = usageOf(events);
  for (const k of Object.keys(s.stats)) s.stats[k] += u[k];
  s.last = lastText(events) ?? s.last;
  s.messages += events.filter((e) => e.type === "message_end").length;
  s.streaming = false;
}
async function handle(socket, id, command) {
  record({ kind: "command", command });
  const ok = (data) => send(socket, data === undefined ? { id, type: "response", command: command.type, success: true } : { id, type: "response", command: command.type, success: true, data });
  const fail = (error) => send(socket, { id, type: "response", command: command.type, success: false, error });
  if (command.type === env.FAKE_DAEMON_REFUSE) return fail(`${command.type} refused`);
  const s = command.activeSessionId ? sessions.get(command.activeSessionId) : undefined;
  const needSession = !["list", "create", "shutdown", "roster_subscribe"].includes(command.type);
  if (needSession && !s) return fail(`Unknown active session: ${command.activeSessionId}`);
  switch (command.type) {
    case "list": return env.FAKE_DAEMON_BAD_ROSTER ? ok({ sessions: null }) : ok({ sessions: [...sessions.values()].map(summary) });
    case "create": {
      const authFile = path.join(command.config?.agentDir ?? "", "auth.json");
      record({ kind: "auth_at_create", auth: existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf8")) : null });
      const created = create(command);
      if (typeof created === "string") return fail(created);
      return ok(summary(created));
    }
    case "get_system_prompt": return ok({ systemPrompt: "fake system prompt" });
    case "get_resource_snapshot": {
      // TAI-273 §2.2 item 10 (N0 e31 shape): the parent lists its create config skills; another session only what it found.
      const found = s.discovered ? JSON.parse(env.FAKE_DAEMON_CHILD_SKILLS ?? "[]")
        : [...(s.config.skills ?? []), ...JSON.parse(env.FAKE_DAEMON_FOUND_SKILLS ?? "[]")];
      if (env.FAKE_DAEMON_SNAPSHOT_FAILS === "1") return fail("snapshot unavailable");
      const agents = path.join(s.cwd ?? "", "AGENTS.md");
      return ok({ skills: found.map((dir) => ({ name: path.basename(dir), filePath: path.join(dir, "SKILL.md"), sourceInfo: { baseDir: dir } })),
        contextFiles: existsSync(agents) ? [{ path: agents }] : [], prompts: [], themes: [], diagnostics: { skills: [], prompts: [], themes: [] } });
    }
    case "roster_subscribe":
      subscribers.add(socket);
      return ok({ roster: [...sessions.values()].map(rosterItem) });
    case "cancel_rlm_child": {
      const child = [...sessions.values()].find((c) => c.rlmChildId === command.childId);
      if (child) child.running = false;
      return ok({ cancelled: Boolean(child) });
    }
    case "delete_rlm_subagent": {
      const child = [...sessions.values()].find((c) => c.rlmChildId === command.childId);
      if (!child || env.FAKE_DAEMON_END_FAILS === "1") return ok({ deleted: false, reason: child ? "refused" : "unknown" });
      if (child.running) return ok({ deleted: false, reason: "running" });
      endSession(child);
      return ok({ deleted: true });
    }
    case "attach": s.clients.add(socket); return ok({ activeSessionId: s.id, snapshot: { activeSessionId: s.id, summary: summary(s), messages: [] } });
    case "detach": s.clients.delete(socket); return ok();
    case "set_thinking_level": s.thinking = command.level; return ok();
    case "set_model": s.provider = command.provider; s.model = command.modelId; return ok();
    case "set_rlm_max_depth": s.rlmMaxDepth = command.maxDepth; return ok({ maxDepth: command.maxDepth, source: "chat", globalSaved: false });
    case "get_session_stats": {
      if (env.FAKE_DAEMON_CHILD_STATS_MISSING && s !== [...sessions.values()][0]) return fail("Child stats unavailable");
      const t = s.stats;
      return ok({ sessionFile: s.sessionFile, sessionId: s.sessionId, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: s.messages,
        tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, total: t.total }, cost: t.cost });
    }
    case "get_last_assistant_text": return ok({ text: s.last });
    case "wait_for_headless_completion": {
      if (env.FAKE_DAEMON_HEADLESS_ERROR) return fail(env.FAKE_DAEMON_HEADLESS_ERROR);
      if (env.FAKE_DAEMON_LATE_CHILD) {
        const message = { role: "assistant", content: [{ type: "text", text: "CHILD SAID KESTREL-4" }], stopReason: "stop" };
        emit(s, { type: "message_end", message }); emit(s, { type: "agent_end", messages: [message] }); s.last = "CHILD SAID KESTREL-4";
      }
      const a = s.config.autonomous ?? {};
      return ok({ enabled: a.enabled === true, continuationsUsed: 0, turnsUsed: 1, tokensUsed: s.stats.total,
        limits: { maxContinuations: a.maxContinuations ?? 3, maxTurns: a.maxTurns ?? 12, maxTokens: a.maxTokens ?? 80000, timeoutMs: a.timeoutMs ?? 1800000 },
        gates: { commands: a.gates?.commands ?? [], maxRetries: a.gates?.maxRetries ?? 3, timeoutMs: a.gates?.timeoutMs ?? 300000 }, gateAttempts: {}, subagentKeepAliveMs: 1500000 });
    }
    case "prompt_and_wait": {
      if (s.streaming) return fail(PROCESSING);
      if (command.message === "/goal clear") {
        // N0 item 7: a slash command, no model request. FAKE_DAEMON_GOAL_CLEAR=ignore leaves the goal in place.
        if (env.FAKE_DAEMON_GOAL_CLEAR !== "ignore") {
          const command_ = { name: "goal", args: "clear", text: "/goal clear" };
          appendFileSync(s.sessionFile, `${JSON.stringify({ type: "custom_message", customType: "session_slash_command_result", content: "Goal cleared.", details: { command: command_, success: true } })}\n`);
          appendFileSync(s.sessionFile, `${JSON.stringify({ type: "custom", customType: "thread_goal_state", data: { active: false, status: "idle" } })}\n`);
        }
        return ok();
      }
      s.prompted = true;
      const mode = env.FAKE_DAEMON_PROMPT_MODE ?? "ok";
      if (mode === "busy") return fail(PROCESSING);
      if (env.FAKE_DAEMON_EDIT_SETTINGS) mergeJson(path.join(s.config.agentDir, "settings.json"), JSON.parse(env.FAKE_DAEMON_EDIT_SETTINGS));
      if (env.FAKE_DAEMON_EDIT_AUTH) mergeJson(path.join(s.config.agentDir, "auth.json"), JSON.parse(env.FAKE_DAEMON_EDIT_AUTH));
      // FAKE_DAEMON_REMOVE_FILES: paths removed by "the agent" during its turn (git clean, rm -rf); FAKE_DAEMON_LINKS: {path: target}.
      for (const file of JSON.parse(env.FAKE_DAEMON_REMOVE_FILES ?? "[]")) rmSync(file, { recursive: true, force: true });
      for (const [link, target] of Object.entries(JSON.parse(env.FAKE_DAEMON_LINKS ?? "{}"))) symlinkSync(target, link);
      // FAKE_DAEMON_WRITE_FILES: {absolute path: content}, written by "the agent" during its turn.
      for (const [file, content] of Object.entries(JSON.parse(env.FAKE_DAEMON_WRITE_FILES ?? "{}"))) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      }
      if (env.FAKE_DAEMON_AUDIT_CHILD) {
        // A finished depth-1 child whose turns come from FAKE_DAEMON_AUDIT_CHILD (a JSON list of assistant messages).
        // Its update carries no sessionFile; the adapter finds the file through get_session_stats and list.
        const child = create({ config: s.config }, 1);
        child.depth = 1;
        child.stats = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0 };
        for (const message of JSON.parse(env.FAKE_DAEMON_AUDIT_CHILD)) appendTurn(child, message);
        if (env.FAKE_DAEMON_AUDIT_CHILD_NO_FILE === "1") rmSync(child.sessionFile, { force: true });
        emit(s, { type: "rlm_child_update", child: { activeSessionId: child.id, status: "done" } });
      }
      if (env.FAKE_DAEMON_AUTH_DIR === "1") {
        // TAI-273 §3.2: a tool replaces auth.json with a non-empty directory, so the adapter can neither check nor delete it.
        rmSync(path.join(s.config.agentDir, "auth.json"), { force: true });
        mkdirSync(path.join(s.config.agentDir, "auth.json", "x"), { recursive: true });
      }
      if (mode === "error") {
        const error = env.FAKE_DAEMON_PROMPT_ERROR ?? "No API key found for anthropic.";
        // N0 item 14: a provider failure is an assistant message with stopReason "error" and diagnostics[0].details.kind.
        const kind = env.FAKE_DAEMON_PROMPT_DIAGNOSTIC;
        const failed = kind ? [{ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: error,
          diagnostics: [{ type: "provider_stream_failure", details: { kind, status: kind === "auth" ? 401 : 429 } }] } }] : [];
        for (const e of [{ type: "agent_start" }, { type: "turn_start" }, ...failed, { type: "turn_end", error }, { type: "agent_end" }]) emit(s, e);
        return fail(error);
      }
      s.streaming = true;
      if (env.FAKE_DAEMON_QUOTA_PARKED === "1") { s.quotaParked = true; rosterChanged(s); }
      spawnSessions(s);
      if (mode === "hang" || mode === "hang_hard") {
        emit(s, { type: "agent_start" });
        s.pending = { ok, fail, mode };
        return undefined;
      }
      setTimeout(() => {
        for (const child of s.spawned ?? []) {
          if (!child.running || !sessions.has(child.id)) continue;
          child.running = false;
          if (child.depth > 0) emit(s, { type: "rlm_child_update", child: { activeSessionId: child.id, status: "done" } });
        }
        if (env.FAKE_DAEMON_CHILD_INSIDE) emit(s, { type: "rlm_child_update", child: { activeSessionId: "inside", status: "done" } });
        finishPrompt(s, eventsOf());
        if (env.FAKE_DAEMON_DELAYED_CHILD) {
          s.childRunning = true;
          emit(s, { type: "rlm_child_update", child: { activeSessionId: "delayed-child", status: "running" } });
          if (env.FAKE_DAEMON_CHILD_STATS) {
            const child = create({ config: s.config }); child.stats = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100, cost: 0.01 }; s.statsChild = child;
            emit(s, { type: "rlm_child_update", child: { activeSessionId: child.id, status: "running" } });
            child.depth = 1;
            if (env.FAKE_DAEMON_GRANDCHILD) {
              const grandchild = create({ config: s.config }); grandchild.depth = 2;
              grandchild.stats = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, cost: 0.001 };
            }
          }
          if (env.FAKE_DAEMON_DELAYED_CHILD !== "hang") setTimeout(() => {
            s.childRunning = false;
            const done = () => {
              if (s.statsChild) emit(s, { type: "rlm_child_update", child: { activeSessionId: s.statsChild.id, status: "done" } });
              emit(s, { type: "rlm_child_update", child: { activeSessionId: "delayed-child", status: "done" } });
            };
            if (!env.FAKE_DAEMON_LATE_DONE) done();
            setTimeout(() => {
              s.streaming = true;
              setTimeout(() => {
              const message = { role: "assistant", content: [{ type: "text", text: "CHILD SAID KESTREL-4" }], stopReason: "stop" };
              finishPrompt(s, [{ type: "message_end", message }, { type: "agent_end", messages: [message] }]);
              if (env.FAKE_DAEMON_LATE_DONE) setTimeout(done, 500);
              }, 200);
            }, Number(env.FAKE_DAEMON_FOLLOWUP_GAP_MS ?? "0"));
          }, 2000);
        }
        ok();
      }, Number(env.FAKE_DAEMON_PROMPT_DELAY_MS ?? "0"));
      return undefined;
    }
    case "abort": {
      ok();
      if (s.pending && s.pending.mode === "hang") {
        const p = s.pending; s.pending = null;
        finishPrompt(s, [{ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } }, { type: "agent_end", messages: [] }]);
        p.ok();
      }
      return undefined;
    }
    case "kill": {
      if (env.FAKE_DAEMON_END_FAILS === "1" && s.depth !== undefined) return ok();
      if (s.pending) { const p = s.pending; s.pending = null; p.fail(`Active session ${s.id} closed`); }
      for (const c of s.clients) send(c, { type: "session_closed", activeSessionId: s.id, reason: "killed" });
      endSession(s);
      return ok();
    }
    case "shutdown":
      ok();
      if (env.FAKE_DAEMON_IGNORE_SHUTDOWN === "1") return record({ kind: "shutdown_ignored" });
      setImmediate(() => shutdown());
      return undefined;
    default: return fail(`Unknown daemon command: ${command.type}`);
  }
}
const HELLO = { type: "daemon_hello", socketPath, protocol: { name: "prime-agent.daemon", version: 7 }, schemaId: "protocol-7-schema-30-8e4b17c2a9f5",
  schemaRevision: 30, appVersion: "0.10.0", runtime: { buildId: "pa-daemon-rs-0.10.0", executablePath: process.argv[1] },
  supervisorPid: process.pid, clientId: "fakeclient01", serverCapabilities: ["attach_snapshot", "event_sequence", "client_owned_sessions", "session_input_admission"] };
const server = net.createServer((socket) => {
  clients.add(socket);
  send(socket, { ...HELLO, clientId: `fake${clients.size}` });
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type !== "command" || message.protocol?.name !== "prime-agent.daemon" || message.protocol?.version !== 7 || typeof message.id !== "string") {
        send(socket, { id: message.id, type: "response", command: String(message.command?.type ?? message.type), success: false, error: "Invalid daemon command envelope" });
        continue;
      }
      void handle(socket, message.id, message.command);
    }
  });
  socket.on("close", () => { clients.delete(socket); subscribers.delete(socket); for (const s of sessions.values()) s.clients.delete(socket); });
  socket.on("error", () => undefined);
});
function shutdown() {
  record({ kind: "shutdown" });
  for (const c of clients) { send(c, { type: "daemon_closing", reason: "shutdown" }); c.destroy(); }
  server.close();
  rmSync(socketPath, { force: true });
  process.exit(0);
}
rmSync(socketPath, { force: true });
server.listen(socketPath, () => record({ kind: "listening" }));
