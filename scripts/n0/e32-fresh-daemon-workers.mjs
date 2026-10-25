// N0 addendum C step 1 (TAI-273 plan rev 9 §2.2 item 11, daemon-workers/ on the keep-list): a fresh daemon resumes a parent
// with old children. Which files in the older daemon's daemon-workers/<id>/ dirs does it open, and which processes does it start?
// strace is not installed on this host, so files come from inotifywait on the agent dir and processes from a /proc scan of
// the new daemon's descendants every 100 ms. Arg "clean": daemon A stops as the adapter stops it. Arg "crash": SIGKILL of
// A and every worker group. Offline (scripts/n0/offline.sh); no prompt goes to daemon B.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createConfig, delay, requests, scratch, seedAgentDir, show, startDaemon, startFake, tree, turn } from "./harness.mjs";

const mode = process.argv[2] ?? "clean";
const s = scratch(`e32-${mode}`);
const fake = await startFake(s);
seedAgentDir(s, fake);
const workersDir = path.join(s.agentDir, "daemon-workers");

/** pid -> { ppid, args } for every process. */
function procTable() {
  const out = new Map();
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const args = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      out.set(Number(name), { ppid, args });
    } catch {
      // gone
    }
  }
  return out;
}
const descendants = (table, root) => {
  const found = [];
  const walk = (pid) => { for (const [child, info] of table) if (info.ppid === pid) { found.push([child, info.args]); walk(child); } };
  walk(root);
  return found;
};
const short = (args) => args.replace(s.dir, "<scratch>").slice(0, 150);

// Daemon A: a parent with a finished depth-1 child, a finished create_session session and a busy depth-1 child.
const a = await startDaemon(s);
let parentFile;
let workers = [];
try {
  const created = await a.req({ type: "create", lifecycle: "resident", config: createConfig(s) }, 60_000);
  parentFile = created.data.sessionFile;
  await turn(a, created.data.activeSessionId, "BEGINCMD\nh = await rlm.spawn('SAY<<<child-reply>>>', name='w1')\nprint('COLLECT', await rlm.collect(h, timeout_ms=30000))\nh2 = await rlm.create_session('SAY<<<session-reply>>>', name='s1')\nprint('SESSION', h2)\nh3 = await rlm.spawn('SLEEP<<<60>>>', name='w2')\nprint('BUSY', h3)\nimport asyncio\nawait asyncio.sleep(3)\nENDCMD");
  const rows = (await a.req({ type: "list" })).data?.sessions ?? [];
  show("A roster before stop", rows.map((r) => ({ depth: r.rlmDepth, kind: r.runtimeKind, activity: r.activity, sessionId: r.sessionId, workerPid: r.workerPid })));
  workers = rows.map((r) => r.workerPid).filter((p) => typeof p === "number");
} finally {
  if (mode === "crash") {
    process.kill(a.pid, "SIGKILL");
    for (const w of workers) { try { process.kill(-w, "SIGKILL"); } catch {} }
  } else {
    await a.stop();
  }
}
await delay(1500);
const oldDirs = fs.existsSync(workersDir) ? fs.readdirSync(workersDir) : [];
show(`daemon-workers/ after A (${mode})`, tree(workersDir));
const r0 = requests(s).length;

// Daemon B on a new socket path, watched.
const watchLog = path.join(s.dir, "inotify.log");
const watch = spawn("inotifywait", ["-m", "-r", "-q", "--format", "%e %w%f", "-e", "open,access,modify,create,delete,moved_to,moved_from,attrib", workersDir],
  { stdio: ["ignore", fs.openSync(watchLog, "w"), "inherit"] });
await delay(800);
const sb = { ...s, dir: path.join(s.dir, "b") };
fs.mkdirSync(sb.dir, { recursive: true });
const seen = new Map();
let scanning = true;
let bPid = null;
const scan = (async () => { while (scanning) { if (bPid) for (const [pid, args] of descendants(procTable(), bPid)) if (!seen.has(pid)) seen.set(pid, args); await delay(100); } })();
const b = await startDaemon(sb);
bPid = b.pid;
try {
  await delay(3000);
  show("B roster before create", ((await b.req({ type: "list" })).data?.sessions ?? []).map((r) => ({ depth: r.rlmDepth, sessionId: r.sessionId })));
  show("B descendants before create", [...seen].map(([pid, args]) => `${pid} ${short(args)}`));
  const resumed = await b.req({ type: "create", lifecycle: "resident", config: createConfig(s), sessionPath: parentFile }, 60_000);
  show("B create sessionPath=<A parent>", { success: resumed.success, error: resumed.error ?? null });
  await delay(8000);
  show("B roster 8 s after create", ((await b.req({ type: "list" })).data?.sessions ?? []).map((r) => ({ depth: r.rlmDepth, kind: r.runtimeKind, sessionId: r.sessionId, workerPid: r.workerPid })));
  show("B descendants, all seen", [...seen].map(([pid, args]) => `${pid} ${short(args)}`));
  show("requests at the fake after B started (none expected)", requests(s).length - r0);
} finally {
  scanning = false;
  await scan;
  await b.stop();
  watch.kill("SIGTERM");
  fake.stop();
}
const lines = fs.readFileSync(watchLog, "utf8").trim().split("\n").filter(Boolean);
const onOld = lines.filter((l) => oldDirs.some((d) => l.includes(`/daemon-workers/${d}/`) || l.endsWith(`/daemon-workers/${d}`)));
const opened = [...new Set(onOld.filter((l) => /OPEN|ACCESS/.test(l)).map((l) => l.split(" ").slice(1).join(" ").replace(workersDir, "daemon-workers")))];
show("files in A's daemon-workers dirs that B opened or read", opened.length ? opened : "(none)");
show("writes, creates, deletes or moves in A's dirs", onOld.filter((l) => /MODIFY|CREATE|DELETE|MOVED|ATTRIB/.test(l)).slice(0, 40));
show("daemon-workers dirs after B", fs.readdirSync(workersDir).map((d) => `${d}${oldDirs.includes(d) ? " (A)" : " (B)"}`));
show("processes from A still alive", execSync("ps -eo pid,args --no-headers", { encoding: "utf8" }).split("\n").filter((l) => l.includes(s.dir) && !l.includes("/b/")).map((l) => short(l.trim())));
show("scratch", s.dir);
