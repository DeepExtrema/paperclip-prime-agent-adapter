// TAI-273 plan rev 8 §2.2 item 10: the explicit skill list, and the check of Prime's own skill list in every session.
import fs from "node:fs/promises";
import path from "node:path";

/** The built-ins a governed parent gets, by path from the Prime release (rev 6, accepted in TAI-337). */
export const PRIME_BUILTIN_SKILL_ALLOWLIST = ["agent-message", "agent-observe", "attach-image", "compact", "edit", "refine"] as const;
/** Exact bytes of the workspace file <cwd>/.prime/agent/settings.json (no newline). */
export const PRIME_WORKSPACE_SETTINGS = '{"skills":["!**"]}';

/** The release dir of the Prime binary: dirname of the command's real path. A bare name is looked up on the child PATH. */
export async function primeReleaseDir(command: string, env: Record<string, string | undefined>): Promise<string | null> {
  const candidates = path.isAbsolute(command) ? [command] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return path.dirname(await fs.realpath(candidate));
    } catch {
      // next PATH entry
    }
  }
  return null;
}

/** `<release>/skills/<name>` for each allowlisted built-in, plus `goal` when adapterConfig.goal is set. */
export function primeBuiltinSkillDirs(releaseDir: string, withGoal: boolean): string[] {
  return [...PRIME_BUILTIN_SKILL_ALLOWLIST, ...(withGoal ? ["goal"] : [])].map((name) => path.join(releaseDir, "skills", name));
}

export interface PrimeSkillCheck {
  ok: boolean;
  /** Skill dirs in the snapshot that are not on the explicit list. */
  notAllowed: string[];
  /** Explicit dirs missing from the snapshot (parent only). */
  missing: string[];
  /** The snapshot's contextFiles paths. */
  contextFiles: string[];
  reason: string | null;
}

type Requester = { request(command: Record<string, unknown> & { type: string }, timeoutMs: number | null): Promise<{ success: boolean; data?: unknown; error?: string }> };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const realOrSame = async (dir: string) => fs.realpath(dir).catch(() => path.resolve(dir));

/**
 * get_system_prompt (it makes Prime load its resources), then get_resource_snapshot, for one session.
 * parent: the list must be non-empty and hold every explicit dir. Every session: each skill's dir must be an explicit dir.
 */
export async function checkPrimeSkillList(client: Requester, activeSessionId: string, explicitDirs: string[], parent: boolean): Promise<PrimeSkillCheck> {
  const fail = (reason: string, extra: Partial<PrimeSkillCheck> = {}): PrimeSkillCheck =>
    ({ ok: false, notAllowed: [], missing: [], contextFiles: [], reason, ...extra });
  const prompt = await client.request({ type: "get_system_prompt", activeSessionId }, 30_000).catch((err: unknown) => ({ success: false, error: String(err) }));
  if (!prompt.success) return fail(`get_system_prompt failed: ${prompt.error ?? "no error text"}`);
  const snapshot = await client.request({ type: "get_resource_snapshot", activeSessionId }, 30_000).catch((err: unknown) => ({ success: false, error: String(err), data: undefined }));
  const data = snapshot.success && isObject(snapshot.data) ? snapshot.data : null;
  if (!data || !Array.isArray(data.skills)) return fail(`get_resource_snapshot failed: ${snapshot.error ?? "no skill list"}`);
  const contextFiles = Array.isArray(data.contextFiles)
    ? data.contextFiles.flatMap((entry) => (isObject(entry) && typeof entry.path === "string" ? [entry.path] : [])) : [];
  const allowed = new Map<string, string>();
  for (const dir of explicitDirs) {
    allowed.set(path.resolve(dir), dir);
    allowed.set(await realOrSame(dir), dir);
  }
  const seen = new Set<string>();
  const notAllowed: string[] = [];
  for (const skill of data.skills) {
    const file = isObject(skill) && typeof skill.filePath === "string" ? skill.filePath : null;
    const dir = file ? path.dirname(file) : null;
    const match = dir ? allowed.get(path.resolve(dir)) ?? allowed.get(await realOrSame(dir)) : undefined;
    if (match) seen.add(match);
    else notAllowed.push(dir ?? JSON.stringify(skill).slice(0, 200));
  }
  const missing = parent ? explicitDirs.filter((dir) => !seen.has(dir)) : [];
  // TAI-365: Prime says why it dropped a skill only in diagnostics.skills ({ type, message, path }); that text goes into the reason.
  const diagnostics = new Map<string, string[]>();
  const skillDiagnostics = isObject(data.diagnostics) && Array.isArray(data.diagnostics.skills) ? data.diagnostics.skills : [];
  for (const entry of skillDiagnostics) {
    if (!isObject(entry) || typeof entry.path !== "string" || typeof entry.message !== "string") continue;
    const dir = path.dirname(entry.path);
    const match = allowed.get(path.resolve(dir)) ?? allowed.get(await realOrSame(dir));
    if (match) diagnostics.set(match, [...(diagnostics.get(match) ?? []), entry.message]);
  }
  const withDiagnostics = (dir: string) => (diagnostics.has(dir) ? `${dir} (Prime: ${diagnostics.get(dir)!.join("; ")})` : dir);
  const reason = parent && data.skills.length === 0 ? "the skill list is empty"
    : notAllowed.length > 0 ? `skills not on the list: ${notAllowed.join(", ")}`
    : missing.length > 0 ? `explicit skills missing: ${missing.map(withDiagnostics).join(", ")}` : null;
  return { ok: reason === null, notAllowed, missing, contextFiles, reason };
}
