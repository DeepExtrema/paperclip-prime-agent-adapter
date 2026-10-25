// N0 harness: scratch HOME and agent dir, the fake Anthropic server, and one Prime 0.10.1 daemon.
// Fake keys only. Never point HOME or PRIME_AGENT_CODING_AGENT_DIR at a real Prime dir.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrimeDaemonClient } from "../../dist/server/execute-daemon.js";

export const PRIME = process.env.N0_PRIME ??
  "/home/extremis/.local/share/prime-agent/releases/0.10.1-linux-x64-21ec219183f4134dd23dce9572102e69456066fe374846525561c776d4d1945c/prime-agent";
export const FAKE_API_KEY = "sk-ant-api03-N0FAKEKEY-not-a-real-key";
export const FAKE_OAT_KEY = "sk-ant-oat01-N0FAKEKEY-not-a-real-token";
const here = path.dirname(fileURLToPath(import.meta.url));
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fresh scratch root with home/, agent/, work/ and a log dir. */
export function scratch(name, root = process.env.N0_ROOT ?? path.join(os.tmpdir(), "n0")) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(root, `${name}-`));
  const home = path.join(dir, "home");
  const agentDir = path.join(dir, "agent");
  const work = path.join(dir, "work");
  for (const d of [home, agentDir, path.join(agentDir, "sessions"), work]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  if (path.resolve(home) === path.resolve(os.homedir())) throw new Error("scratch HOME must not be the real HOME");
  return { dir, home, agentDir, sessionDir: path.join(agentDir, "sessions"), work, log: path.join(dir, "fake-requests.jsonl"), statusFile: path.join(dir, "fake-status"), goalHangFile: path.join(dir, "fake-goal-hang") };
}

export async function startFake(s) {
  const portFile = path.join(s.dir, "fake-port");
  const child = spawn(process.execPath, [path.join(here, "fake-anthropic.mjs")], {
    env: { ...process.env, FAKE_LOG: s.log, FAKE_STATUS_FILE: s.statusFile, FAKE_PORT_FILE: portFile, FAKE_GOAL_HANG_FILE: path.join(s.dir, "fake-goal-hang"), FAKE_BODIES: path.join(s.dir, "fake-bodies.jsonl"), FAKE_RETRY_AFTER: process.env.FAKE_RETRY_AFTER ?? "30" }, stdio: ["ignore", "pipe", "inherit"],
  });
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i += 1) await delay(50);
  const port = Number(fs.readFileSync(portFile, "utf8"));
  return { port, url: `http://127.0.0.1:${port}`, stop: () => child.kill("SIGTERM") };
}

/** models.json routes the built-in anthropic provider to the fake server; auth.json holds a fake key. */
export function seedAgentDir(s, fake, { key = FAKE_API_KEY, settings = {}, models = null } = {}) {
  fs.writeFileSync(path.join(s.agentDir, "models.json"), JSON.stringify(models ?? { providers: { anthropic: { baseUrl: fake.url } } }, null, 2));
  fs.writeFileSync(path.join(s.agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key } }), { mode: 0o600 });
  fs.writeFileSync(path.join(s.agentDir, "settings.json"), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function primeEnv(s, extra = {}) {
  return {
    PATH: process.env.PATH, HOME: s.home, USER: process.env.USER, LANG: "C.UTF-8", TMPDIR: path.join(s.dir, "tmp"),
    XDG_CONFIG_HOME: path.join(s.home, ".config"), XDG_DATA_HOME: path.join(s.home, ".local", "share"), XDG_CACHE_HOME: path.join(s.home, ".cache"),
    PRIME_AGENT_CODING_AGENT_DIR: s.agentDir, PRIME_AGENT_TELEMETRY: "0", DO_NOT_TRACK: "1", PRIME_AGENT_ALLOW_HTTP: "1",
    ...(process.env.N0_KERNEL ? { PRIME_AGENT_KERNEL_VENV: path.join(process.env.N0_KERNEL, "venv"), UV_PYTHON_INSTALL_DIR: path.join(process.env.N0_KERNEL, "python"), UV_CACHE_DIR: path.join(process.env.N0_KERNEL, "uv-cache"), UV_OFFLINE: "1" } : {}),
    ...extra,
  };
}

/** Runs prime-agent once (not the daemon) and returns its output. */
export function runPrime(s, args, { env = {}, cwd = s.work, timeoutMs = 60_000 } = {}) {
  fs.mkdirSync(path.join(s.dir, "tmp"), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(PRIME, args, { cwd, env: primeEnv(s, env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

export async function startDaemon(s, { env = {}, cwd = s.work } = {}) {
  const tmp = path.join(s.dir, "tmp");
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const socketPath = path.join(tmp, "d.sock");
  const child = spawn(PRIME, ["--mode", "daemon", "--daemon-socket", socketPath], {
    cwd, env: primeEnv(s, env), detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  let exited = false;
  child.on("exit", () => (exited = true));
  let client = null;
  for (let i = 0; i < 400 && !exited; i += 1) {
    try { client = await PrimeDaemonClient.connect(socketPath, 1000); break; } catch { await delay(50); }
  }
  if (!client) throw new Error(`daemon did not start: ${output}`);
  const events = [];
  client.onMessage((m) => events.push(m));
  const workers = new Set();
  const req = async (command, timeoutMs = 30_000) => {
    const r = await client.request(command, timeoutMs);
    const rows = r?.data?.sessions;
    if (Array.isArray(rows)) for (const row of rows) if (typeof row.workerPid === "number") workers.add(row.workerPid);
    if (typeof r?.data?.workerPid === "number") workers.add(r.data.workerPid);
    return r;
  };
  const stop = async () => {
    await client.request({ type: "shutdown" }, 2000).catch(() => undefined);
    client.close();
    for (let i = 0; i < 100 && !exited; i += 1) await delay(50);
    for (const pid of [child.pid, ...workers]) { try { process.kill(-pid, "SIGKILL"); } catch {} try { process.kill(pid, "SIGKILL"); } catch {} }
  };
  return { pid: child.pid, socketPath, client, req, events, workers, output: () => output, exited: () => exited, stop, connect: () => PrimeDaemonClient.connect(socketPath, 2000) };
}

/** The create config the adapter sends (execute-daemon.ts createConfig), minus Paperclip's prompt text. */
export function createConfig(s, extra = {}) {
  return {
    cwd: s.work, agentDir: s.agentDir, sessionDir: s.sessionDir, provider: "anthropic", model: "claude-opus-5-5",
    thinking: "high", appendSystemPrompt: [], skills: [], serializedRefine: true, telemetryDisabled: true, ...extra,
  };
}

/** prompt_and_wait, then wait_for_headless_completion, as the adapter does. */
export async function turn(d, sid, message, timeoutMs = 120_000) {
  const p = await d.req({ type: "prompt_and_wait", activeSessionId: sid, message, queueIfBusy: false }, timeoutMs);
  const h = await d.req({ type: "wait_for_headless_completion", activeSessionId: sid }, timeoutMs);
  return { prompt: p, headless: h };
}

/** Raw request bodies, in order (FAKE_BODIES). */
export function bodies(s) {
  const file = path.join(s.dir, "fake-bodies.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).body) : [];
}

export function requests(s) {
  return fs.existsSync(s.log) ? fs.readFileSync(s.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export function tree(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(`${path.relative(base, full)}/`); tree(full, base, out); }
    else out.push(path.relative(base, full));
  }
  return out;
}

export const show = (label, value) => console.log(`\n### ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
