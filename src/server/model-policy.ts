// TAI-225 rev 3 §9: adapter-owned model allowlist, settings and auth checks after the run, per-actor model audit.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { PrimePolicyError, type PrimePolicyErrorCode } from "../errors.js";
import type { PrimeCredentialConfig } from "../types.js";

/**
 * Settings keys of Prime 0.10.1 that each hold one model ("provider/modelId" or a bare id), besides the
 * defaultProvider/defaultModel pair. Source: the settings field list in the 0.10.1 binary. Each one is a role:
 * `modelRoles.<key>` overrides it, else it gets adapterConfig.model.
 */
export const PRIME_MODEL_ROLE_KEYS = ["subagentDefaultModel", "auxiliaryModel", "providerBackupModel", "imageModel"] as const;
export type PrimeModelRoleKey = (typeof PRIME_MODEL_ROLE_KEYS)[number];
/** Every settings key the adapter writes before and checks after each run when allowedModels is set. */
export const PRIME_MANAGED_SETTINGS_KEYS = ["allowedModels", "enabledModels", "defaultProvider", "defaultModel", ...PRIME_MODEL_ROLE_KEYS] as const;

export interface PrimeModelPolicy {
  /** null: allowedModels is unset. Only the settings.json read check applies, and the audit only reports. */
  allowedModels: string[] | null;
  /** Managed settings keys and their values; null when allowedModels is unset. */
  managed: Record<string, unknown> | null;
  /** allowedModels unset, daemon runtime: the subagentDefaultModel write the adapter made before §9. */
  legacySubagentDefaultModel: string | null;
}

const isUnset = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const isModelRef = (value: string): boolean => {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
};
const invalid = (message: string): never => {
  throw new PrimePolicyError("prime_allowed_models_invalid", message);
};
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const errno = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));

function parseAllowedModels(value: unknown): string[] | null {
  if (isUnset(value)) return null;
  const list = typeof value === "string" ? value.split(/[\n,]/) : Array.isArray(value) ? value : null;
  if (list === null || list.some((item) => typeof item !== "string")) {
    return invalid("adapterConfig.allowedModels must be a list of provider/modelId strings.");
  }
  const refs = [...new Set((list as string[]).map((item) => item.trim()).filter(Boolean))];
  if (refs.length === 0) return invalid("adapterConfig.allowedModels must name at least one model; an empty list does not restrict Prime.");
  const bad = refs.filter((ref) => !isModelRef(ref));
  if (bad.length > 0) invalid(`adapterConfig.allowedModels entries must be provider/modelId: ${bad.join(", ")}.`);
  return refs;
}

function parseModelRoles(value: unknown): Partial<Record<PrimeModelRoleKey, string>> {
  if (isUnset(value)) return {};
  if (typeof value !== "object" || Array.isArray(value)) return invalid("adapterConfig.modelRoles must be an object of role name to provider/modelId.");
  const roles: Partial<Record<PrimeModelRoleKey, string>> = {};
  for (const [key, ref] of Object.entries(value as Record<string, unknown>)) {
    if (!(PRIME_MODEL_ROLE_KEYS as readonly string[]).includes(key)) {
      invalid(`adapterConfig.modelRoles.${key} is not a Prime model role; roles are ${PRIME_MODEL_ROLE_KEYS.join(", ")}.`);
    }
    if (typeof ref !== "string" || !isModelRef(ref.trim())) invalid(`adapterConfig.modelRoles.${key} must be provider/modelId.`);
    roles[key as PrimeModelRoleKey] = (ref as string).trim();
  }
  return roles;
}

/** Throws PrimePolicyError("prime_allowed_models_invalid"). */
export function resolvePrimeModelPolicy(
  config: Record<string, unknown>,
  model: { modelRef: string; provider: string; model: string },
  native: { runtime: "daemon" | "print"; subagentDefaultModel: string | null },
): PrimeModelPolicy {
  const allowedModels = parseAllowedModels(config.allowedModels);
  const configuredRoles = parseModelRoles(config.modelRoles);
  if (allowedModels === null) {
    if (Object.keys(configuredRoles).length > 0) invalid("adapterConfig.modelRoles needs adapterConfig.allowedModels.");
    return { allowedModels: null, managed: null, legacySubagentDefaultModel: native.runtime === "daemon" ? native.subagentDefaultModel : null };
  }
  const subagent = configuredRoles.subagentDefaultModel;
  if (subagent !== undefined && native.subagentDefaultModel !== null && subagent !== native.subagentDefaultModel) {
    invalid("adapterConfig.subagentDefaultModel and adapterConfig.modelRoles.subagentDefaultModel differ; set one.");
  }
  const roles = Object.fromEntries(PRIME_MODEL_ROLE_KEYS.map((key) => [key,
    configuredRoles[key] ?? (key === "subagentDefaultModel" ? native.subagentDefaultModel : null) ?? model.modelRef])) as Record<PrimeModelRoleKey, string>;
  const outside = [["model", model.modelRef], ...Object.entries(roles)].filter(([, ref]) => !allowedModels.includes(ref!));
  if (outside.length > 0) {
    invalid(`Not in adapterConfig.allowedModels (${allowedModels.join(", ")}): ${outside.map(([key, ref]) => `${key} = ${ref}`).join(", ")}.`);
  }
  return {
    allowedModels,
    managed: { allowedModels, enabledModels: allowedModels, defaultProvider: model.provider, defaultModel: model.model, ...roles },
    legacySubagentDefaultModel: null,
  };
}

// Items 1 to 3: settings.json

export interface PrimeSettingsState {
  file: string;
  managed: Record<string, unknown>;
  /** sha256 of settings.json after the adapter's write (or of the unchanged file). */
  sha256Written: string;
  /** Managed keys present with another value before the run; the adapter put its value back. */
  restoredKeys: string[];
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await fs.rename(temp, file);
}

type SettingsRead = { raw: Buffer | null; value: Record<string, unknown> | null; problem: string | null };

async function readSettings(file: string): Promise<SettingsRead> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(file);
  } catch (err) {
    if (errno(err) === "ENOENT") return { raw: null, value: null, problem: null };
    return { raw: null, value: null, problem: `cannot be read (${errno(err)})` };
  }
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return { raw, value: value as Record<string, unknown>, problem: null };
  } catch {
    // reported below
  }
  return { raw, value: null, problem: "is not a JSON object" };
}

/** Items 1 and 2. Runs before Prime starts. Throws PrimePolicyError("prime_settings_invalid") and then never writes the file. */
export async function preparePrimeSettings(agentDir: string, policy: PrimeModelPolicy, notes: string[]): Promise<PrimeSettingsState | null> {
  const file = path.join(agentDir, "settings.json");
  const read = await readSettings(file);
  if (read.problem !== null) {
    throw new PrimePolicyError("prime_settings_invalid", `${file} ${read.problem}. The adapter does not rewrite it; fix or remove the file.`);
  }
  const current = read.value ?? {};
  if (policy.managed === null) {
    const model = policy.legacySubagentDefaultModel;
    if (model !== null) {
      if (current.subagentDefaultModel !== model) await writePrivateJson(file, { ...current, subagentDefaultModel: model });
      notes.push(`settings.json subagentDefaultModel = ${model}.`);
    }
    return null;
  }
  const managed = policy.managed;
  const differing = Object.keys(managed).filter((key) => !sameJson(current[key], managed[key]));
  const restoredKeys = differing.filter((key) => key in current);
  if (differing.length > 0) await writePrivateJson(file, { ...current, ...managed });
  if (restoredKeys.length > 0) notes.push(`settings.json: restored managed keys changed since the last run: ${restoredKeys.join(", ")}.`);
  notes.push(`settings.json: allowedModels = ${policy.allowedModels!.join(", ")}; model roles ${PRIME_MODEL_ROLE_KEYS.map((key) => `${key} = ${managed[key]}`).join(", ")}.`);
  return { file, managed, sha256Written: sha256(await fs.readFile(file)), restoredKeys };
}

export interface PrimeSettingsCheck {
  file: string;
  sha256Written: string;
  sha256After: string | null;
  restoredKeys: string[];
  /** Managed keys whose value after the run differs from the written one. All of them when the file is gone or unreadable. */
  tamperedKeys: string[];
}

/** Item 3. */
export async function checkPrimeSettings(state: PrimeSettingsState): Promise<PrimeSettingsCheck> {
  const read = await readSettings(state.file);
  const after = read.value;
  const tamperedKeys = Object.keys(state.managed).filter((key) => after === null || !sameJson(after[key], state.managed[key]));
  return { file: state.file, sha256Written: state.sha256Written, sha256After: read.raw ? sha256(read.raw) : null, restoredKeys: state.restoredKeys, tamperedKeys };
}

// Item 4: auth.json

export interface PrimeAuthCheck {
  ok: boolean;
  /** Top-level key names of auth.json (provider names). Values are never read into the result. */
  keys: string[] | null;
  problem: string | null;
}

export async function checkPrimeAuth(agentDir: string, provider: string): Promise<PrimeAuthCheck> {
  const file = path.join(agentDir, "auth.json");
  const fail = (problem: string, keys: string[] | null = null): PrimeAuthCheck => ({ ok: false, keys, problem });
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (err) {
    return fail(`cannot be read (${errno(err)})`);
  }
  if (stat.isSymbolicLink()) return fail("is a symlink");
  if (!stat.isFile()) return fail("is not a regular file");
  if (stat.uid !== process.getuid?.()) return fail("is not owned by this user");
  if ((stat.mode & 0o777) !== 0o600) return fail(`has mode 0${(stat.mode & 0o777).toString(8)}, not 0600`);
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fail("is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("is not a JSON object");
  const keys = Object.keys(value).sort();
  if (keys.length !== 1 || keys[0] !== provider) return fail(`holds providers [${keys.join(", ")}], expected only [${provider}]`, keys);
  return { ok: true, keys, problem: null };
}

// Item 5: per-actor model audit from Prime's own session files

type FileStamp = { size: number; mtimeMs: number };
type ActorInfo = { sessionFile: string | null; depth: number | null; tokens: number | null };

export interface PrimeAuditSources {
  sessionDir: string;
  /** Every *.jsonl under sessionDir before Prime started. */
  snapshot: Map<string, FileStamp>;
  /** prompted: a prompt was sent to the parent in this run. */
  parent: ActorInfo & { sessionId: string | null; prompted: boolean } | null;
  /** Children the daemon reported, by activeSessionId. */
  children: Map<string, ActorInfo>;
}

async function listSessionFiles(dir: string, into = new Map<string, FileStamp>()): Promise<Map<string, FileStamp>> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listSessionFiles(full, into);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const stat = await fs.stat(full);
      into.set(full, { size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return into;
}

export async function startPrimeAudit(sessionDir: string): Promise<PrimeAuditSources> {
  const snapshot = await listSessionFiles(sessionDir).catch(() => new Map<string, FileStamp>());
  return { sessionDir, snapshot, parent: null, children: new Map() };
}

const pick = <T>(next: T | null | undefined, previous: T | null): T | null => (next === undefined || next === null ? previous : next);

export function notePrimeParent(sources: PrimeAuditSources, info: Partial<ActorInfo & { sessionId: string | null; prompted: boolean }>): void {
  const previous = sources.parent ?? { sessionId: null, sessionFile: null, depth: 0, tokens: null, prompted: false };
  sources.parent = { sessionId: pick(info.sessionId, previous.sessionId), sessionFile: pick(info.sessionFile, previous.sessionFile),
    depth: 0, tokens: pick(info.tokens, previous.tokens), prompted: info.prompted ?? previous.prompted };
}

export function notePrimeChild(sources: PrimeAuditSources, activeSessionId: string, info: Partial<ActorInfo>): void {
  const previous = sources.children.get(activeSessionId) ?? { sessionFile: null, depth: null, tokens: null };
  sources.children.set(activeSessionId, { sessionFile: pick(info.sessionFile, previous.sessionFile),
    depth: pick(info.depth, previous.depth), tokens: pick(info.tokens, previous.tokens) });
}

export interface PrimeAuditActor {
  /** Prime session id from the file header. */
  sessionId: string | null;
  /** Daemon activeSessionId, for reported children. */
  activeSessionId: string | null;
  depth: number | null;
  file: string;
  /** provider/model of the assistant turns written during this run. */
  models: string[];
  turns: number;
  turnsWithoutModel: number;
  /** Tokens the daemon's stats show for this actor, when known. */
  tokens: number | null;
}

export interface PrimeModelAudit {
  ok: boolean;
  /** true when allowedModels is set and a failed audit fails the run. */
  enforced: boolean;
  actors: PrimeAuditActor[];
  forbidden: Array<{ sessionId: string | null; activeSessionId: string | null; depth: number | null; model: string; turns: number }>;
  unreadable: Array<{ sessionId: string | null; activeSessionId: string | null; file: string | null; reason: string }>;
  /** Session files that do not exist where no turn can have run: the parent was never prompted, or the daemon's stats show 0 tokens. */
  absent: Array<{ sessionId: string | null; activeSessionId: string | null; file: string; reason: string }>;
}

type Target = { activeSessionId: string | null; sessionId: string | null; depth: number | null; tokens: number | null; noTurnPossible?: boolean };

/** Turns appended since the snapshot. A file that shrank or is new is read whole. */
function readActor(file: string, buffer: Buffer, start: number, target: Target) {
  const newline = buffer.indexOf(10);
  const firstLine = (newline < 0 ? buffer : buffer.subarray(0, newline)).toString("utf8");
  let header: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).type === "session") header = parsed as Record<string, unknown>;
  } catch {
    // An unparseable header is counted with the other lines when the file is read from the start.
  }
  const counts = new Map<string, number>();
  let turns = 0;
  let turnsWithoutModel = 0;
  let badLines = 0;
  for (const line of buffer.subarray(start).toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      badLines += 1;
      continue;
    }
    const message = entry?.type === "message" && typeof entry.message === "object" && entry.message !== null ? entry.message as Record<string, unknown> : null;
    if (message?.role !== "assistant") continue;
    turns += 1;
    const { provider, model } = message;
    if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") turnsWithoutModel += 1;
    else counts.set(`${provider}/${model}`, (counts.get(`${provider}/${model}`) ?? 0) + 1);
  }
  const actor: PrimeAuditActor = {
    sessionId: typeof header.id === "string" ? header.id : target.sessionId,
    activeSessionId: target.activeSessionId,
    depth: typeof header.rlmDepth === "number" ? header.rlmDepth : target.depth,
    file, models: [...counts.keys()].sort(), turns, turnsWithoutModel, tokens: target.tokens,
  };
  return { actor, counts, badLines };
}

export async function auditPrimeModels(sources: PrimeAuditSources, allowedModels: string[] | null): Promise<PrimeModelAudit> {
  const targets = new Map<string, Target>();
  const audit: PrimeModelAudit = { ok: true, enforced: allowedModels !== null, actors: [], forbidden: [], unreadable: [], absent: [] };
  const { parent } = sources;
  if (parent?.sessionFile) {
    targets.set(path.resolve(parent.sessionFile), { activeSessionId: null, sessionId: parent.sessionId, depth: 0, tokens: parent.tokens, noTurnPossible: !parent.prompted });
  }
  for (const [activeSessionId, child] of sources.children) {
    if (!child.sessionFile) {
      audit.unreadable.push({ sessionId: null, activeSessionId, file: null, reason: "the daemon reported this child but no session file for it" });
      continue;
    }
    targets.set(path.resolve(child.sessionFile), { activeSessionId, sessionId: null, depth: child.depth, tokens: child.tokens });
  }
  try {
    for (const [file, stamp] of await listSessionFiles(sources.sessionDir)) {
      const before = sources.snapshot.get(file);
      const changed = !before || before.size !== stamp.size || before.mtimeMs !== stamp.mtimeMs;
      if (changed && !targets.has(file)) targets.set(file, { activeSessionId: null, sessionId: null, depth: null, tokens: null });
    }
  } catch (err) {
    audit.unreadable.push({ sessionId: null, activeSessionId: null, file: sources.sessionDir, reason: `cannot list the session dir (${errno(err)})` });
  }
  for (const [file, target] of targets) {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(file);
    } catch (err) {
      const who = { sessionId: target.sessionId, activeSessionId: target.activeSessionId, file };
      // Prime may create a session file only with its first turn. A missing file passes only when no turn can have run.
      if (errno(err) === "ENOENT" && (target.noTurnPossible || target.tokens === 0)) {
        audit.absent.push({ ...who, reason: target.noTurnPossible ? "no prompt was sent in this run" : "the daemon's stats show 0 tokens" });
      } else {
        audit.unreadable.push({ ...who, reason: `cannot read the session file (${errno(err)})` });
      }
      continue;
    }
    const before = sources.snapshot.get(file)?.size ?? 0;
    const { actor, counts, badLines } = readActor(file, buffer, before <= buffer.length ? before : 0, target);
    audit.actors.push(actor);
    const who = { sessionId: actor.sessionId, activeSessionId: actor.activeSessionId };
    if (badLines > 0) audit.unreadable.push({ ...who, file, reason: `${badLines} line(s) are not JSON` });
    if (actor.turnsWithoutModel > 0) audit.unreadable.push({ ...who, file, reason: `${actor.turnsWithoutModel} assistant turn(s) have no provider or model` });
    if (actor.turns === 0 && (actor.tokens ?? 0) > 0) {
      audit.unreadable.push({ ...who, file, reason: `the daemon's stats show ${actor.tokens} tokens but the file has no assistant turn from this run` });
    }
    if (allowedModels !== null) {
      for (const [model, turns] of counts) if (!allowedModels.includes(model)) audit.forbidden.push({ ...who, depth: actor.depth, model, turns });
    }
  }
  audit.ok = audit.forbidden.length === 0 && audit.unreadable.length === 0;
  return audit;
}

function describeAudit(audit: PrimeModelAudit): string {
  const name = (entry: { sessionId: string | null; activeSessionId: string | null; file?: string | null }) =>
    entry.sessionId ?? entry.activeSessionId ?? entry.file ?? "unknown actor";
  return [
    ...audit.forbidden.map((entry) => `actor ${name(entry)} (depth ${entry.depth ?? "unknown"}) ran ${entry.model} for ${entry.turns} turn(s)`),
    ...audit.unreadable.map((entry) => `actor ${name(entry)}: ${entry.reason}`),
  ].join("; ");
}

/** Items 3 to 5 after the run, whatever its outcome. With allowedModels unset only modelAudit is added, as a report. */
export async function finishPrimeRun(result: AdapterExecutionResult, input: {
  policy: PrimeModelPolicy; settings: PrimeSettingsState | null; credential: PrimeCredentialConfig; agentDir: string; sources: PrimeAuditSources;
}): Promise<AdapterExecutionResult> {
  const { policy, settings, credential, agentDir, sources } = input;
  const enforced = policy.allowedModels !== null;
  const settingsCheck = settings ? await checkPrimeSettings(settings) : null;
  const authCheck = enforced && credential.mode === "api_key" ? await checkPrimeAuth(agentDir, credential.provider) : null;
  const modelAudit = await auditPrimeModels(sources, policy.allowedModels);
  const resultJson = { ...(result.resultJson ?? {}), modelAudit, ...(settingsCheck ? { settings: settingsCheck } : {}), ...(authCheck ? { authCheck } : {}) };
  if (!enforced) return { ...result, resultJson };
  const failures: Array<{ code: PrimePolicyErrorCode; message: string }> = [];
  if (settingsCheck && settingsCheck.tamperedKeys.length > 0) {
    failures.push({ code: "prime_settings_tampered", message: `settings.json managed keys changed during the run: ${settingsCheck.tamperedKeys.join(", ")}.` });
  }
  if (authCheck && !authCheck.ok) failures.push({ code: "prime_auth_tampered", message: `auth.json after the run ${authCheck.problem}.` });
  if (!modelAudit.ok) failures.push({ code: "prime_model_audit_failed", message: `Model audit failed: ${describeAudit(modelAudit)}.` });
  const forbidden = modelAudit.forbidden[0];
  // The usage row keeps the config model only when the audit is ok.
  const label = modelAudit.ok ? {} : forbidden ? { provider: forbidden.model.slice(0, forbidden.model.indexOf("/")), model: forbidden.model } : { model: "unverified" };
  if (failures.length === 0) return { ...result, ...label, resultJson };
  const { sessionId: _id, sessionParams: _params, sessionDisplayId: _display, ...rest } = result;
  return {
    ...rest, ...label, resultJson,
    exitCode: result.exitCode === 0 ? 1 : result.exitCode,
    errorCode: failures[0]!.code,
    errorMessage: [...failures.map((failure) => failure.message), ...(result.errorCode ? [`Run result before the checks: ${result.errorCode}${result.errorMessage ? ` (${result.errorMessage})` : ""}.`] : [])].join(" "),
    errorMeta: { ...result.errorMeta, primeErrorCode: failures[0]!.code, policyFailures: failures.map((failure) => failure.code),
      runErrorCode: result.errorCode ?? null, runErrorMessage: result.errorMessage ?? null },
  };
}
