// TAI-273 plan rev 7 §2.2 items 3, 4, 6, 8 and 9: run-start moves and the run-end report under featureProfile "governed-v1".
// No move or write here follows a symlink: fs.rename moves a link as a link, and every path is checked with lstat first.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PrimeFeatureProfile } from "./feature-profile.js";

const CONTEXT_FILES = ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"] as const;
const WORKSPACE_CONTEXT_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;
const HARNESS_KEPT_KIND = "memory";
const MAX_HASHED_FILES = 1000;

export type Sha = string | null;
export interface DisabledEntry { name: string; kind: "file" | "dir" | "symlink" | "other"; sha256: Sha }
export interface MovedFile { path: string; sha256: Sha }
export interface ForeignGoal { goalId: string | null; objective: string; status: string; action: "cleared" | "fresh_session" }

/** Filled during the run by the daemon path (items 2 and 7). */
export interface GovernedRunLive {
  sessions: number;
  sessionsEnded: string[];
  foreignGoals: ForeignGoal[];
}

export interface GovernedRunState {
  profile: PrimeFeatureProfile;
  agentDir: string;
  cwd: string;
  runId: string;
  disabledDir: string;
  agentSkillsDisabled: Array<{ name: string; sha256: Sha }>;
  agentDirDisabled: DisabledEntry[];
  contextFilesDisabled: Array<{ name: string; sha256: Sha }>;
  projectConfigDisabled: MovedFile[];
  scheduledJobsDisabled: number;
  harnessEntriesDisabled: Array<{ kind: string; id: string }>;
  harnessBefore: Sha;
  refinementEventsBefore: number;
  contextFilesBefore: Map<string, Sha>;
  /** Warnings found at run start (moves of entries an earlier run left). */
  startWarnings: string[];
  live: GovernedRunLive;
}

export interface GovernedReport {
  profile: string;
  maxSubagentsPerRun: number;
  sessions: number;
  sessionsEnded: string[];
  skillDiscovery: "off" | "on";
  agentSkills: string[];
  agentSkillsDisabled: Array<{ name: string; sha256: Sha }>;
  agentDirDisabled: DisabledEntry[];
  contextFilesDisabled: Array<{ name: string; sha256: Sha }>;
  contextFilesCreated: Array<{ name: string; sha256: Sha }>;
  projectConfigDisabled: MovedFile[];
  projectConfigCreated: MovedFile[];
  workspaceContextFiles: Record<string, { before: Sha; after: Sha }>;
  settingsKeysRemoved: string[];
  foreignGoals: ForeignGoal[];
  scheduledJobsDisabled: number;
  scheduledJobsCreated: number;
  harnessEntriesDisabled: Array<{ kind: string; id: string }>;
  harnessBytes: number;
  harnessFingerprint: { before: Sha; after: Sha };
  refinementEvents: { before: number; after: number };
  cachesCleared: Array<{ name: string; sha256: Sha }>;
  modelCatalog: null;
  warnings: string[];
}

const errno = (err: unknown) => (err as NodeJS.ErrnoException).code;
const lstat = (file: string) => fs.lstat(file).catch((err) => (errno(err) === "ENOENT" || errno(err) === "ENOTDIR" ? null : Promise.reject(err)));
const kindOf = (stat: Awaited<ReturnType<typeof fs.lstat>>): DisabledEntry["kind"] =>
  stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
const safeRunId = (runId: string) => runId.replace(/[^A-Za-z0-9_-]/g, "_") || "run";

/** sha256 of a regular file, without following a final symlink; null when absent or not a regular file. */
async function sha256File(file: string): Promise<Sha> {
  const stat = await lstat(file);
  if (!stat?.isFile()) return null;
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

/** sha256 of a file read through links, for context files Prime itself reads that way. */
async function sha256Readable(file: string): Promise<Sha> {
  try {
    return createHash("sha256").update(await fs.readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

/** Every regular file and link under dir (links are not followed), by path relative to base. */
async function hashTree(dir: string, base: string, into: MovedFile[] = []): Promise<MovedFile[]> {
  const stat = await lstat(dir);
  if (!stat) return into;
  if (!stat.isDirectory()) {
    into.push({ path: path.relative(base, dir), sha256: stat.isFile() ? await sha256File(dir) : null });
    return into;
  }
  for (const name of (await fs.readdir(dir)).sort()) {
    if (into.length >= MAX_HASHED_FILES) break;
    await hashTree(path.join(dir, name), base, into);
  }
  return into;
}

async function treeBytes(dir: string): Promise<number> {
  const stat = await lstat(dir);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
  let total = 0;
  for (const name of await fs.readdir(dir)) total += await treeBytes(path.join(dir, name));
  return total;
}

async function lineCount(file: string): Promise<number> {
  const stat = await lstat(file);
  if (!stat?.isFile()) return 0;
  return (await fs.readFile(file, "utf8")).split("\n").filter((line) => line.trim() !== "").length;
}

/** `<agentDir>/.paperclip-disabled/<runId>/`, created as real directories. */
async function ensureDisabledDir(agentDir: string, runId: string): Promise<string> {
  const root = path.join(agentDir, ".paperclip-disabled");
  for (const dir of [root, path.join(root, safeRunId(runId))]) {
    const stat = await lstat(dir);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`${dir} is not a real directory; the adapter does not move files through it.`);
    if (!stat) await fs.mkdir(dir, { mode: 0o700 });
  }
  return path.join(root, safeRunId(runId));
}

/** Renames source to target, or to target.<n> when target exists. Links move as links. */
async function moveTo(source: string, target: string): Promise<string> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let candidate = target;
  for (let n = 1; await lstat(candidate); n += 1) candidate = `${target}.${n}`;
  await fs.rename(source, candidate);
  return candidate;
}

/** Disabled-entry record for an agent-dir entry: sha256 for files only (item 11's form). */
async function describe(file: string, name: string): Promise<DisabledEntry | null> {
  const stat = await lstat(file);
  if (!stat) return null;
  return { name, kind: kindOf(stat), sha256: stat.isFile() ? await sha256File(file) : null };
}

/** Item 4: every scheduled-jobs.json under session-artifacts/, at any depth. */
async function findJobFiles(dir: string, into: string[] = []): Promise<string[]> {
  const stat = await lstat(dir);
  if (!stat?.isDirectory()) return into;
  for (const name of await fs.readdir(dir)) {
    const full = path.join(dir, name);
    const entry = await lstat(full);
    if (entry?.isDirectory()) await findJobFiles(full, into);
    else if (name === "scheduled-jobs.json" && entry) into.push(full);
  }
  return into;
}

/** Item 6 exception: AGENTS.md / CLAUDE.md (and the .MD spellings) in cwd and every parent up to /. */
async function findContextFiles(cwd: string): Promise<Map<string, Sha>> {
  const found = new Map<string, Sha>();
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of WORKSPACE_CONTEXT_NAMES) {
      if (names.includes(name)) found.set(path.join(dir, name), await sha256Readable(path.join(dir, name)));
    }
    if (path.dirname(dir) === dir) break;
  }
  return found;
}

type HarnessFile = Record<string, unknown> & { entries?: Record<string, unknown> };

/** Item 8: keep schema, refinements and entries.memory; empty every other kind; report each removed entry. */
async function stripHarness(agentDir: string, disabledDir: string, removed: Array<{ kind: string; id: string }>, warnings: string[]): Promise<void> {
  const dir = path.join(agentDir, "harness");
  const file = path.join(dir, "harness_state.json");
  const dirStat = await lstat(dir);
  if (dirStat && !dirStat.isDirectory()) {
    await moveTo(dir, path.join(disabledDir, "harness"));
    warnings.push(`agent-dir harness is not a directory; moved aside: ${dir}`);
    return;
  }
  const stat = await lstat(file);
  if (!stat) return;
  if (!stat.isFile()) {
    await moveTo(file, path.join(disabledDir, "harness", "harness_state.json"));
    warnings.push(`global harness store is not a regular file; moved aside: ${file}`);
    return;
  }
  const raw = await fs.readFile(file, "utf8");
  let state: HarnessFile;
  try {
    state = JSON.parse(raw) as HarnessFile;
    if (typeof state !== "object" || state === null || Array.isArray(state)) throw new Error("not an object");
  } catch {
    await moveTo(file, path.join(disabledDir, "harness", "harness_state.json"));
    warnings.push(`global harness store is not a JSON object; moved aside: ${file}`);
    return;
  }
  const entries = typeof state.entries === "object" && state.entries !== null && !Array.isArray(state.entries) ? state.entries : {};
  const kept: Record<string, unknown> = {};
  let changed = false;
  for (const [kind, value] of Object.entries(entries)) {
    if (kind === HARNESS_KEPT_KIND) { kept[kind] = value; continue; }
    const ids = Array.isArray(value)
      ? value.map((entry, index) => String((entry as Record<string, unknown> | null)?.id ?? index))
      : typeof value === "object" && value !== null ? Object.keys(value) : [];
    for (const id of ids) removed.push({ kind, id });
    if (ids.length > 0) changed = true;
    kept[kind] = Array.isArray(value) ? [] : typeof value === "object" && value !== null ? {} : value;
  }
  if (!changed) return;
  await fs.mkdir(path.join(disabledDir, "harness"), { recursive: true, mode: 0o700 });
  await fs.copyFile(file, path.join(disabledDir, "harness", "harness_state.json"));
  const temp = path.join(dir, `.harness_state.json.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify({ ...state, entries: kept }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await fs.rename(temp, file);
}

const harnessKinds = async (agentDir: string): Promise<Array<{ kind: string; count: number }>> => {
  try {
    const state = JSON.parse(await fs.readFile(path.join(agentDir, "harness", "harness_state.json"), "utf8")) as HarnessFile;
    const entries = typeof state.entries === "object" && state.entries !== null ? state.entries : {};
    return Object.entries(entries).filter(([kind]) => kind !== HARNESS_KEPT_KIND).map(([kind, value]) => ({
      kind, count: Array.isArray(value) ? value.length : typeof value === "object" && value !== null ? Object.keys(value).length : 0,
    }));
  } catch {
    return [];
  }
};

/** Run start, before Prime starts: items 4, 6, 8 (strip and refine stores) and 9. Item 11 runs after this. */
export async function startGovernedRun(input: {
  profile: PrimeFeatureProfile; agentDir: string; cwd: string; runId: string;
}): Promise<GovernedRunState> {
  const { profile, agentDir, cwd, runId } = input;
  const disabledDir = await ensureDisabledDir(agentDir, runId);
  const state: GovernedRunState = {
    profile, agentDir, cwd, runId, disabledDir, agentSkillsDisabled: [], agentDirDisabled: [], contextFilesDisabled: [], projectConfigDisabled: [],
    scheduledJobsDisabled: 0, harnessEntriesDisabled: [], harnessBefore: null, refinementEventsBefore: 0, contextFilesBefore: new Map(),
    startWarnings: [], live: { sessions: 0, sessionsEnded: [], foreignGoals: [] },
  };
  // Item 4: saved Prime schedules.
  for (const file of await findJobFiles(path.join(agentDir, "session-artifacts"))) {
    await moveTo(file, `${file}.disabled-${safeRunId(runId)}`);
    state.scheduledJobsDisabled += 1;
  }
  // Item 6, agent dir: context files.
  for (const name of CONTEXT_FILES) {
    const file = path.join(agentDir, name);
    const stat = await lstat(file);
    if (!stat) continue;
    state.contextFilesDisabled.push({ name, sha256: await sha256File(file) });
    await moveTo(file, path.join(disabledDir, name));
  }
  // Item 6, workspace: <cwd>/.prime/agent/ (or a .prime link) moves aside whole.
  const primeDir = path.join(cwd, ".prime");
  const primeStat = await lstat(primeDir);
  const projectDir = primeStat?.isSymbolicLink() || (primeStat && !primeStat.isDirectory()) ? primeDir : path.join(primeDir, "agent");
  if (await lstat(projectDir)) {
    state.projectConfigDisabled = await hashTree(projectDir, cwd);
    await moveTo(projectDir, `${projectDir}.disabled-${safeRunId(runId)}`);
  }
  // Item 8: the kernel store keeps only memory; both refine stores move aside.
  await stripHarness(agentDir, disabledDir, state.harnessEntriesDisabled, state.startWarnings);
  state.harnessBefore = await sha256File(path.join(agentDir, "harness", "harness_state.json"));
  for (const name of ["harness_state.json", path.join("sessions", "harness")]) {
    const entry = await describe(path.join(agentDir, name), name);
    if (!entry) continue;
    await moveTo(path.join(agentDir, name), path.join(disabledDir, name));
    state.agentDirDisabled.push(entry);
    state.startWarnings.push(`agent-dir refine store moved aside: ${name}`);
  }
  state.refinementEventsBefore = await lineCount(path.join(agentDir, "refinement_history.jsonl"));
  // Item 9: every entry under <agentDir>/skills/, files too (or the skills link itself).
  const skillsDir = path.join(agentDir, "skills");
  const skillsStat = await lstat(skillsDir);
  if (skillsStat && !skillsStat.isDirectory()) {
    state.agentSkillsDisabled.push({ name: "skills", sha256: skillsStat.isFile() ? await sha256File(skillsDir) : null });
    await moveTo(skillsDir, path.join(disabledDir, "skills"));
  } else if (skillsStat) {
    for (const name of (await fs.readdir(skillsDir)).sort()) {
      const full = path.join(skillsDir, name);
      const stat = await lstat(full);
      const sha256 = stat?.isDirectory() ? await sha256File(path.join(full, "SKILL.md")) : await sha256File(full);
      state.agentSkillsDisabled.push({ name, sha256 });
      await moveTo(full, path.join(disabledDir, "skills", name));
    }
  }
  state.contextFilesBefore = await findContextFiles(cwd);
  return state;
}

/** Run end, after the daemon stopped. settingsKeysRemoved comes from the settings allowlist (item 5). */
export async function finishGovernedRun(state: GovernedRunState, settingsKeysRemoved: string[]): Promise<GovernedReport> {
  const { agentDir, cwd } = state;
  const warnings = [...state.startWarnings];
  const contextFilesCreated: Array<{ name: string; sha256: Sha }> = [];
  for (const name of CONTEXT_FILES) {
    const stat = await lstat(path.join(agentDir, name));
    if (!stat) continue;
    contextFilesCreated.push({ name, sha256: await sha256File(path.join(agentDir, name)) });
    warnings.push(`new agent-dir context file: ${name}`);
  }
  const primeDir = path.join(cwd, ".prime");
  const primeStat = await lstat(primeDir);
  const projectConfigCreated = primeStat?.isSymbolicLink() || (primeStat && !primeStat.isDirectory())
    ? await hashTree(primeDir, cwd) : await hashTree(path.join(primeDir, "agent"), cwd);
  for (const file of projectConfigCreated) warnings.push(`new workspace Prime config file: ${file.path}`);
  const skillsDir = path.join(agentDir, "skills");
  const agentSkills = (await lstat(skillsDir))?.isDirectory() ? (await fs.readdir(skillsDir)).sort() : (await lstat(skillsDir)) ? ["skills"] : [];
  for (const name of agentSkills) warnings.push(`new agent-installed skill: ${name}`);
  for (const { kind, count } of await harnessKinds(agentDir)) {
    if (count > 0) warnings.push(`new global harness ${kind} entries: ${count}`);
  }
  const after = await findContextFiles(cwd);
  const workspaceContextFiles: Record<string, { before: Sha; after: Sha }> = {};
  const resolvedCwd = path.resolve(cwd);
  for (const file of [...new Set([...state.contextFilesBefore.keys(), ...after.keys()])].sort()) {
    const entry = { before: state.contextFilesBefore.get(file) ?? null, after: after.get(file) ?? null };
    workspaceContextFiles[file] = entry;
    if (path.dirname(file) !== resolvedCwd) warnings.push(`context file above cwd is loaded on every run: ${file}`);
    else if (entry.before !== entry.after) warnings.push(`workspace context file changed: ${file}`);
  }
  const scheduledJobsCreated = (await findJobFiles(path.join(agentDir, "session-artifacts"))).length;
  return {
    profile: state.profile.profile, maxSubagentsPerRun: state.profile.maxSubagentsPerRun,
    sessions: state.live.sessions, sessionsEnded: state.live.sessionsEnded, skillDiscovery: "on",
    agentSkills, agentSkillsDisabled: state.agentSkillsDisabled, agentDirDisabled: state.agentDirDisabled,
    contextFilesDisabled: state.contextFilesDisabled, contextFilesCreated,
    projectConfigDisabled: state.projectConfigDisabled, projectConfigCreated, workspaceContextFiles,
    settingsKeysRemoved, foreignGoals: state.live.foreignGoals,
    scheduledJobsDisabled: state.scheduledJobsDisabled, scheduledJobsCreated,
    harnessEntriesDisabled: state.harnessEntriesDisabled, harnessBytes: await treeBytes(path.join(agentDir, "harness")),
    harnessFingerprint: { before: state.harnessBefore, after: await sha256File(path.join(agentDir, "harness", "harness_state.json")) },
    refinementEvents: { before: state.refinementEventsBefore, after: await lineCount(path.join(agentDir, "refinement_history.jsonl")) },
    cachesCleared: [], modelCatalog: null, warnings,
  };
}
