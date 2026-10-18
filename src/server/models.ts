// Owner: WP4. Contract: INTERFACES.md §8.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { runChildProcess, type RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import { PrimeCliError } from "../errors.js";
import {
  type DetectPrimeModel,
  type EphemeralPrimeAgentDir,
  type ListPrimeModels,
  type ParsePrimeModelList,
  type PrimeModelRow,
} from "../types.js";
import { buildPrimeChildEnv, createEphemeralPrimeAgentDir, resolvePrimeDefaultCommand, seedPrimeAgentDir } from "./runtime-config.js";

export const parsePrimeModelList: ParsePrimeModelList = (stdout) => {
  const rows: PrimeModelRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trimEnd().split(/\s{2,}/);
    if (cols.length !== 6 || (cols[0] === "provider" && cols[1] === "model")) continue;
    const [provider, model, context, maxOut, thinking, images] = cols as [string, string, string, string, string, string];
    rows.push({ provider, model, id: `${provider}/${model}`, context, maxOut, thinking: thinking === "yes", images: images === "yes" });
  }
  return rows;
};

const MODEL_LIST_TIMEOUT_SEC = 20;
const MODEL_LIST_GRACE_SEC = 3;
const firstNonEmptyLine = (text: string): string => text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";

function toAdapterModels(rows: PrimeModelRow[]): AdapterModel[] {
  const ids = [...new Set(rows.map((row) => row.id))];
  ids.sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
  return ids.map((id) => ({ id, label: id }));
}

/** Uncached `<command> model list`. Throws PrimeCliError. */
async function discoverPrimeModels({ command, env, cwd }: Parameters<ListPrimeModels>[0]): Promise<AdapterModel[]> {
  const agentDir = env.PRIME_AGENT_CODING_AGENT_DIR;
  const home = os.homedir();
  const expandedAgentDir = agentDir === "~" ? home : agentDir?.startsWith("~/") ? path.join(home, agentDir.slice(2)) : agentDir;
  const hostAgentDir = path.resolve(home, ".prime", "agent");
  if (expandedAgentDir && path.resolve(expandedAgentDir) === hostAgentDir) {
    throw new PrimeCliError("prime_model_list_failed", `listPrimeModels refuses the host default agent dir: ${hostAgentDir}`);
  }
  if (!agentDir || !path.isAbsolute(agentDir)) {
    throw new PrimeCliError("prime_model_list_failed", "listPrimeModels requires env.PRIME_AGENT_CODING_AGENT_DIR set to an absolute per-agent or ephemeral agent dir.");
  }
  let result: RunProcessResult;
  try {
    // A8: env goes through unchanged, undefined entries included. runChildProcess merges process.env under it,
    // then deletes keys whose value is undefined; its declared opts.env type omits undefined, hence the cast.
    const runId = `prime-models-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    result = await runChildProcess(runId, command, ["model", "list"], { cwd, env: env as Record<string, string>, timeoutSec: MODEL_LIST_TIMEOUT_SEC, graceSec: MODEL_LIST_GRACE_SEC, onLog: async () => {} });
  } catch (err) {
    throw new PrimeCliError("prime_cli_missing", `Cannot run \`${command}\`: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (result.timedOut) {
    throw new PrimeCliError("prime_model_list_failed", `\`${command} model list\` timed out after ${MODEL_LIST_TIMEOUT_SEC} s.`);
  }
  const exitCode = result.exitCode ?? 1;
  if (exitCode !== 0) {
    const detail = firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout);
    throw new PrimeCliError("prime_model_list_failed", `\`${command} model list\` failed (exit ${exitCode})${detail ? `: ${detail}` : "."}`);
  }
  return toAdapterModels(parsePrimeModelList(result.stdout));
}

const MODELS_CACHE_TTL_MS = 60_000;
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID"]);
const discoveryCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();
const isVolatileEnvKey = (key: string): boolean =>
  VOLATILE_ENV_KEY_EXACT.has(key) || VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

/** A stripped key (value undefined, INTERFACES §16 A8) keys differently from an absent, inherited one. */
function discoveryCacheKey(command: string, cwd: string, env: Record<string, string | undefined>): string {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value === undefined ? "<unset>" : createHash("sha256").update(value).digest("hex")}`)
    .join("\n");
  return `${command}\n${cwd}\n${env.PRIME_AGENT_CODING_AGENT_DIR ?? ""}\n${envKey}`;
}

/** Cached (60 s) `prime-agent model list` in the given agent dir. Throws PrimeCliError. */
export const listPrimeModels: ListPrimeModels = async (input) => {
  const key = discoveryCacheKey(input.command, input.cwd, input.env);
  const now = Date.now();
  for (const [cachedKey, entry] of discoveryCache) if (entry.expiresAt <= now) discoveryCache.delete(cachedKey);
  const cached = discoveryCache.get(key);
  if (cached) return cached.models;
  const models = await discoverPrimeModels(input);
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
};

/** Test helper: clears the model caches. */
export function resetPrimeModelsCacheForTests(): void {
  discoveryCache.clear();
  hostModelsCache = null;
}

let hostModelsCache: { expiresAt: number; models: AdapterModel[] } | null = null;

async function loadHostModels(): Promise<AdapterModel[]> {
  let ephemeral: EphemeralPrimeAgentDir | null = null;
  try {
    ephemeral = await createEphemeralPrimeAgentDir({ mode: "host_auth", hostAuthFile: path.join(os.homedir(), ".prime", "agent", "auth.json") });
    await seedPrimeAgentDir(ephemeral.plan, { provider: "", env: {} });
    const { env } = buildPrimeChildEnv(process.env, ephemeral.plan, {});
    const command = await resolvePrimeDefaultCommand(process.env);
    const models = await discoverPrimeModels({ command, env, cwd: ephemeral.plan.agentDir });
    hostModelsCache = { expiresAt: Date.now() + MODELS_CACHE_TTL_MS, models };
    return models;
  } catch {
    return [];
  } finally {
    await ephemeral?.cleanup();
  }
}

/** ServerAdapterModule.listModels: host-credential ephemeral agent dir; [] on any failure. */
export async function listPrimeModelsForAdapter(): Promise<AdapterModel[]> {
  if (hostModelsCache && hostModelsCache.expiresAt > Date.now()) return hostModelsCache.models;
  return loadHostModels();
}

/** ServerAdapterModule.refreshModels: as listPrimeModelsForAdapter, bypassing the cache. */
export async function refreshPrimeModelsForAdapter(): Promise<AdapterModel[]> {
  return loadHostModels();
}

/** Model check for execute and testEnvironment (INTERFACES §8). Throws PrimeCliError("prime_model_unknown"). */
export function assertPrimeModelListed(modelRef: string, models: AdapterModel[]): void {
  if (models.some((entry) => entry.id === modelRef)) return;
  const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
  throw new PrimeCliError("prime_model_unknown", `Configured Prime model is not listed: ${modelRef}. Listed models: ${sample || "(none)"}${models.length > 12 ? ", ..." : ""}`);
}

export const detectPrimeModel: DetectPrimeModel = async (agentDir) => {
  const source = path.join(agentDir, "settings.json");
  try {
    const raw: unknown = JSON.parse(await fs.readFile(source, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const { defaultProvider, defaultModel } = raw as Record<string, unknown>;
    if (typeof defaultProvider !== "string" || !defaultProvider.trim() || typeof defaultModel !== "string" || !defaultModel.trim()) return null;
    return { provider: defaultProvider, model: `${defaultProvider}/${defaultModel}`, source };
  } catch {
    return null;
  }
};

/** ServerAdapterModule.detectModel: detectPrimeModel(<os.homedir()>/.prime/agent). */
export async function detectPrimeModelForAdapter(): ReturnType<DetectPrimeModel> {
  const detected = await detectPrimeModel(path.join(os.homedir(), ".prime", "agent"));
  return detected ? { ...detected, source: "~/.prime/agent/settings.json" } : null;
}
