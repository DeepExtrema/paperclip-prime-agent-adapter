// TAI-273 plan rev 10 §2.2 item 13 (TAI-340 change 2 and Sentinel's two optional checks): one governed run per agent dir,
// and no process of the agent outlives the run. The marker is PRIME_AGENT_CODING_AGENT_DIR=<agentDir>, which the adapter
// sets in the Prime child env, and which every daemon, worker, kernel and shell process of the run carries (F23).
import fs from "node:fs/promises";

/** Shared by every copy of this module in the server process: the host's adapter reload re-imports it with a `?t=` URL. */
const RUNS_KEY = Symbol.for("paperclip.prime_agent_local.governedRuns");
const SCAN_MS = 100;
const SWEEP_WAIT_MS = 2000;
const COMMAND_CHARS = 200;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function governedRuns(): Set<string> {
  const store = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  return (store[RUNS_KEY] ??= new Set<string>());
}

/** Adds the agent dir; false when a governed run for it is already in progress. */
export function acquireGovernedRun(agentDir: string): boolean {
  const runs = governedRuns();
  if (runs.has(agentDir)) return false;
  runs.add(agentDir);
  return true;
}
export function releaseGovernedRun(agentDir: string): void { governedRuns().delete(agentDir); }

export interface MarkedProcess { pid: number; sessionId: number; command: string; startTime: string }
/** featureProfile.processesSwept entry; sessionId is the process session id (field 6 of /proc/<pid>/stat). */
export interface ProcessSwept { pid: number; sessionId: number; command: string; stopped: boolean }

/** Fields after the last ")" of /proc/<pid>/stat: [state, ppid, pgrp, session, …, starttime at index 19]. */
async function statFields(pid: number): Promise<string[] | null> {
  try {
    const text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return text.slice(text.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** The server's own pid and its ancestors, which the scan never signals. */
async function selfAndAncestors(): Promise<Set<number>> {
  const out = new Set<number>();
  for (let pid = process.pid; pid > 1 && !out.has(pid);) {
    out.add(pid);
    const fields = await statFields(pid);
    pid = fields ? Number(fields[1]) : 0;
  }
  return out;
}

/** Every live process whose /proc/<pid>/environ holds the exact marker entry. Unreadable environs are skipped. */
export async function findMarkedProcesses(agentDir: string): Promise<MarkedProcess[]> {
  const marker = `PRIME_AGENT_CODING_AGENT_DIR=${agentDir}`;
  const skip = await selfAndAncestors();
  const found: MarkedProcess[] = [];
  for (const name of await fs.readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(name) || skip.has(Number(name))) continue;
    const pid = Number(name);
    let environ: string;
    try { environ = await fs.readFile(`/proc/${pid}/environ`, "latin1"); } catch { continue; }
    if (!environ.split("\0").includes(marker)) continue;
    const fields = await statFields(pid);
    if (!fields || fields[0] === "Z") continue;
    const command = await fs.readFile(`/proc/${pid}/cmdline`, "utf8").then((text) => text.split("\0").filter(Boolean).join(" "), () => "");
    found.push({ pid, sessionId: Number(fields[3]), command: command.slice(0, COMMAND_CHARS), startTime: fields[19] ?? "" });
  }
  return found;
}

/** The leftover-check message: pid, session id and command of each, then the kill -9 line. */
export function describeLeftovers(agentDir: string, found: MarkedProcess[]): string {
  const list = found.map((p) => `pid ${p.pid} (session ${p.sessionId}): ${p.command || "?"}`).join("; ");
  return `Processes from an earlier run of this agent are still alive (${agentDir}): ${list}. End them with: kill -9 ${found.map((p) => p.pid).join(" ")}`;
}

/** Run end: SIGKILL every marked process, re-scanned every 100 ms for up to 2 s. A pid whose start time changed is not signalled. */
export async function sweepMarkedProcesses(agentDir: string): Promise<ProcessSwept[]> {
  const seen = new Map<number, MarkedProcess>();
  const until = Date.now() + SWEEP_WAIT_MS;
  for (;;) {
    const found = await findMarkedProcesses(agentDir);
    if (found.length === 0) break;
    for (const proc of found) {
      if (!seen.has(proc.pid)) seen.set(proc.pid, proc);
      const now = await statFields(proc.pid);
      if (!now || now[19] !== proc.startTime) continue;
      try { process.kill(proc.pid, "SIGKILL"); } catch { /* gone */ }
    }
    if (Date.now() >= until) break;
    await delay(SCAN_MS);
  }
  const swept: ProcessSwept[] = [];
  for (const proc of seen.values()) {
    const now = await statFields(proc.pid);
    const stopped = !now || now[0] === "Z" || now[19] !== proc.startTime;
    swept.push({ pid: proc.pid, sessionId: proc.sessionId, command: proc.command, stopped });
  }
  return swept;
}
