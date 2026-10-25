// TAI-273 plan rev 9 §4.3 item 5 (F23), with Sentinel's TAI-340 change 1: persistent shells end when the run ends.
// bash(..., persistent=True) starts a shell that leads its own session (start_new_session=True), so no group signal of the
// daemon or a worker reaches it. Prime records each one in <agentDir>/persistent-shells/<id>.json { id, pid, startId, sessionId }
// (N0 item 18). The reap uses Prime's own rule: never signal a pid whose start id differs (a reused pid).
import fs from "node:fs/promises";
import path from "node:path";

export interface PersistentShellKill { shellId: string; sessionId: string | null; pid: number; when: "run_start" | "run_end"; stopped: boolean }

const SCAN_MS = 100;
const STOP_WAIT_MS = 2000;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** /proc/<pid>/stat, read after the last ")": state, session id (field 6) and start time (field 22). null when gone. */
async function procStat(pid: number): Promise<{ state: string; session: number; startId: string } | null> {
  try {
    const text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0] ?? "", session: Number(fields[3]), startId: `proc:${fields[19]}` };
  } catch {
    return null;
  }
}

/** Live (not zombie) processes whose session id is `session`. */
async function sessionMembers(session: number): Promise<number[]> {
  const members: number[] = [];
  for (const name of await fs.readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await procStat(Number(name));
    if (stat && stat.session === session && stat.state !== "Z") members.push(Number(name));
  }
  return members;
}

const signal = (pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } };

/** SIGKILL to -pid and to every process in the shell's session, re-scanned every 100 ms for up to 2 s. */
async function endShellSession(pid: number): Promise<boolean> {
  const until = Date.now() + STOP_WAIT_MS;
  try { process.kill(-pid, "SIGKILL"); } catch { /* no such group */ }
  for (;;) {
    const members = await sessionMembers(pid);
    if (members.length === 0) return true;
    for (const member of members) signal(member);
    if (Date.now() >= until) return false;
    await delay(SCAN_MS);
  }
}

/**
 * Ends each live shell recorded under <agentDir>/persistent-shells/. sessionIds: only shells of those sessions (a config
 * without governed-v1); null: every recorded shell. The record files are left as they are.
 */
export async function reapPersistentShells(agentDir: string, options: {
  when: PersistentShellKill["when"]; sessionIds: ReadonlySet<string> | null; onLog: (line: string) => Promise<void> | void;
}): Promise<{ killed: PersistentShellKill[]; warnings: string[] }> {
  const killed: PersistentShellKill[] = [];
  const warnings: string[] = [];
  const dir = path.join(agentDir, "persistent-shells");
  const dirStat = await fs.lstat(dir).catch(() => null);
  if (!dirStat) return { killed, warnings };
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    const text = `${dir} is ${dirStat.isSymbolicLink() ? "a symlink" : "not a directory"}; persistent shells were not reaped`;
    warnings.push(text);
    await options.onLog(`[paperclip] warning: ${text}\n`);
    return { killed, warnings };
  }
  for (const name of (await fs.readdir(dir)).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    let record: unknown;
    try { record = JSON.parse(await fs.readFile(file, "utf8")); } catch { continue; }
    if (!isObject(record) || !Number.isInteger(record.pid) || (record.pid as number) <= 1 || typeof record.startId !== "string") continue;
    const pid = record.pid as number;
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : null;
    if (options.sessionIds && (sessionId === null || !options.sessionIds.has(sessionId))) continue;
    const proc = await procStat(pid);
    if (!proc || proc.state === "Z" || proc.startId !== record.startId) continue;
    const shellId = typeof record.id === "string" ? record.id : name.slice(0, -".json".length);
    const stopped = await endShellSession(pid);
    killed.push({ shellId, sessionId, pid, when: options.when, stopped });
    await options.onLog(stopped
      ? `[paperclip] ended persistent shell ${shellId} (pid ${pid}, session ${sessionId ?? "unknown"})\n`
      : `[paperclip] warning: persistent shell ${shellId} (pid ${pid}) did not stop\n`);
  }
  return { killed, warnings };
}
