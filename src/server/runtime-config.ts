// Owner: WP1. Contract: INTERFACES.md §2-§4. Replace the stub bodies; keep the typed exports.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  asBoolean, asNumber, asStringArray, ensurePathInEnv, parseObject, resolvePaperclipInstanceRootForAdapter,
  sanitizeInheritedPaperclipEnv,
} from "@paperclipai/adapter-utils/server-utils";
import { notImplemented, PrimeConfigError, PrimeCredentialError } from "../errors.js";
import {
  PRIME_ADAPTER_OWNED_ENV_KEYS, PRIME_ALWAYS_STRIPPED_ENV_PREFIXES, PRIME_DEFAULT_COMMAND, PRIME_PROVIDER_CREDENTIAL_ENV_KEYS,
  PRIME_STRIPPED_ENV_PREFIXES, PRIME_THINKING_LEVELS, type BuildPrimeChildEnv, type CreateEphemeralPrimeAgentDir,
  type PrimeCredentialConfig, type PrimeThinkingLevel, type ResolvePrimeRuntimeConfig, type SeedPrimeAgentDir,
  type SeededPrimeAgentDir,
} from "../types.js";

// §2 resolvePrimeRuntimeConfig
const DEFAULT_GRACE_SEC = 20; // pi-local execute.ts:373
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/; // agent and company ids become agent dir path segments
const isUnset = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const trimmedText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
/** Templates and prompts keep their exact text. */
const rawText = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const nonNegative = (value: unknown, fallback: number): number => {
  const parsed = asNumber(value, fallback);
  return parsed >= 0 ? parsed : fallback;
};

function absolutePath(value: unknown, key: string): string | null {
  const text = trimmedText(value);
  if (text === null) return null;
  if (!path.isAbsolute(text)) {
    throw new PrimeConfigError("prime_path_invalid", `adapterConfig.${key} must be an absolute path.`);
  }
  return path.resolve(text);
}

function splitModelRef(value: unknown): { modelRef: string; provider: string; model: string } {
  const modelRef = trimmedText(value) ?? "";
  if (modelRef === "") {
    throw new PrimeConfigError("prime_model_required", "adapterConfig.model is required as provider/modelId (for example anthropic/claude-haiku-4-5).");
  }
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) {
    throw new PrimeConfigError("prime_model_invalid", `adapterConfig.model "${modelRef}" must be provider/modelId with both parts non-empty.`);
  }
  return { modelRef, provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}

function parseThinking(value: unknown): PrimeThinkingLevel | null {
  if (isUnset(value)) return null;
  const level = PRIME_THINKING_LEVELS.find((candidate) => candidate === trimmedText(value));
  if (level === undefined) {
    throw new PrimeConfigError("prime_thinking_invalid", `adapterConfig.thinking must be one of ${PRIME_THINKING_LEVELS.join(", ")}.`);
  }
  return level;
}

function parseCredential(config: Record<string, unknown>, provider: string): PrimeCredentialConfig {
  const mode = isUnset(config.credentialMode) ? "host_auth" : config.credentialMode;
  if (mode === "api_key") {
    const apiKeyEnvVar = trimmedText(config.apiKeyEnvVar);
    if (apiKeyEnvVar === null) {
      throw new PrimeConfigError("prime_api_key_env_var_required", "adapterConfig.apiKeyEnvVar is required when credentialMode is api_key.");
    }
    return { mode: "api_key", provider, apiKeyEnvVar };
  }
  if (mode !== "host_auth") {
    throw new PrimeConfigError("prime_credential_mode_invalid", "adapterConfig.credentialMode must be host_auth or api_key.");
  }
  const hostAuthFile = absolutePath(config.hostAuthFile, "hostAuthFile");
  return { mode: "host_auth", hostAuthFile: hostAuthFile ?? path.join(os.homedir(), ".prime", "agent", "auth.json") };
}

export const resolvePrimeRuntimeConfig: ResolvePrimeRuntimeConfig = (config, agent, instanceRoot) => {
  const { modelRef, provider, model } = splitModelRef(config.model);
  const thinking = parseThinking(isUnset(config.thinking) ? config.thinkingEffort : config.thinking); // §16 A6
  const credential = parseCredential(config, provider);
  const cwd = absolutePath(config.cwd, "cwd");
  if (!SAFE_PATH_SEGMENT.test(agent.id) || !SAFE_PATH_SEGMENT.test(agent.companyId)) {
    throw new PrimeConfigError("prime_path_invalid", "Agent and company ids must match [A-Za-z0-9_-]+.");
  }
  if (!path.isAbsolute(instanceRoot)) {
    throw new PrimeConfigError("prime_path_invalid", `Paperclip instance root must be absolute: ${instanceRoot}`);
  }
  const agentDirRoot =
    absolutePath(config.agentDirRoot, "agentDirRoot") ?? path.join(instanceRoot, "companies", agent.companyId, "agents");
  const agentDir = path.join(agentDirRoot, agent.id, "prime-agent-home");
  const extraArgs = asStringArray(config.extraArgs);
  const env = Object.entries(parseObject(config.env)).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return {
    command: trimmedText(config.command) ?? PRIME_DEFAULT_COMMAND,
    modelRef, provider, model, thinking, cwd,
    instructionsFilePath: trimmedText(config.instructionsFilePath),
    promptTemplate: rawText(config.promptTemplate),
    bootstrapPromptTemplate: rawText(config.bootstrapPromptTemplate),
    appendSystemPrompt: rawText(config.appendSystemPrompt),
    noContextFiles: asBoolean(config.noContextFiles, false),
    timeoutSec: nonNegative(config.timeoutSec, 0),
    graceSec: nonNegative(config.graceSec, DEFAULT_GRACE_SEC),
    extraArgs: extraArgs.length > 0 ? extraArgs : asStringArray(config.args), // pi-local execute.ts:405-409
    env: Object.fromEntries(env),
    credential,
    agentDir: { kind: "agent", agentDir, sessionDir: path.join(agentDir, "sessions"), credential },
  };
};

// §3 agent dir
async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

/** Creates the new auth.json under a temp name in the same dir, then renames it over auth.json (atomic). */
async function replaceAuthFile(authFile: string, create: (temp: string) => Promise<void>): Promise<void> {
  const temp = path.join(path.dirname(authFile), `.auth.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await create(temp);
    await fs.rename(temp, authFile);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** codex-local ensureSymlink pattern (codex-home.ts:220-249): a copy goes stale because refresh tokens are single-use. */
async function linkHostAuth(authFile: string, hostAuthFile: string): Promise<void> {
  const current = await fs.readlink(authFile).catch(() => null);
  if (current === hostAuthFile) return;
  await replaceAuthFile(authFile, (temp) => fs.symlink(hostAuthFile, temp));
}

function isPrivateRegularFile(stat: { isFile(): boolean; uid: number; mode: number }): boolean {
  return stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
}

async function assertHostAuthFile(hostAuthFile: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(hostAuthFile);
  } catch (err) {
    const hint = "Log in with prime-agent (/login) on the host, or set credentialMode to api_key.";
    throw new PrimeCredentialError("prime_host_auth_missing", `Host Prime auth file not found: ${hostAuthFile}. ${hint}`, { cause: err });
  }
  if (!isPrivateRegularFile(stat)) {
    const message = `Host Prime auth file ${hostAuthFile} must be a regular file owned by this user with mode 0600.`;
    throw new PrimeCredentialError("prime_host_auth_unsafe", message);
  }
}

/** Reads only `<provider>.type`; no other field of the host file is logged or returned. */
async function readHostBillingType(hostAuthFile: string, provider: string): Promise<SeededPrimeAgentDir["billingType"]> {
  if (provider === "") return "unknown";
  try {
    const type = parseObject(parseObject(JSON.parse(await fs.readFile(hostAuthFile, "utf8")))[provider]).type;
    if (type === "oauth") return "subscription";
    if (type === "api_key") return "api";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export const seedPrimeAgentDir: SeedPrimeAgentDir = async (plan, input) => {
  await ensurePrivateDir(plan.agentDir);
  await ensurePrivateDir(plan.sessionDir);
  const authFile = path.join(plan.agentDir, "auth.json");
  const notes = [`Prime agent dir: ${plan.agentDir} (${plan.kind}).`];
  const credential = plan.credential;
  if (credential.mode === "host_auth") {
    await assertHostAuthFile(credential.hostAuthFile);
    await linkHostAuth(authFile, credential.hostAuthFile);
    notes.push(`auth.json -> ${credential.hostAuthFile} (host Prime credential).`);
    const billingType = await readHostBillingType(credential.hostAuthFile, input.provider);
    return { plan, auth: "host_auth_symlink", billingType, notes };
  }
  return notImplemented("WP1", "seedPrimeAgentDir api_key");
};

export const createEphemeralPrimeAgentDir: CreateEphemeralPrimeAgentDir = async (credential) => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-prime-agent-"));
  const sessionDir = path.join(agentDir, "sessions");
  const cleanup = async (): Promise<void> => {
    await fs.rm(agentDir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await fs.mkdir(sessionDir, { mode: 0o700 });
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { plan: { kind: "ephemeral", agentDir, sessionDir, credential }, cleanup };
};

// §4 buildPrimeChildEnv
function hasPrefix(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

const PROVIDER_KEYS: readonly string[] = PRIME_PROVIDER_CREDENTIAL_ENV_KEYS;
const OWNED_KEYS: readonly string[] = PRIME_ADAPTER_OWNED_ENV_KEYS;

/** Stripped keys stay as explicit undefined: runChildProcess merges process.env first, then deletes undefined keys (§16 A8). */
export const buildPrimeChildEnv: BuildPrimeChildEnv = (base, plan, paperclipEnv) => {
  const dropped = new Set<string>();
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(sanitizeInheritedPaperclipEnv(base))) { // §16 A17: no server PAPERCLIP_* secrets
    if (value === undefined) continue;
    const strip = hasPrefix(key, PRIME_STRIPPED_ENV_PREFIXES) || PROVIDER_KEYS.includes(key);
    if (strip) dropped.add(key);
    env[key] = strip ? undefined : value;
  }
  for (const [key, value] of Object.entries(paperclipEnv)) {
    const strip = hasPrefix(key, PRIME_ALWAYS_STRIPPED_ENV_PREFIXES) || OWNED_KEYS.includes(key);
    if (strip) dropped.add(key);
    env[key] = strip ? undefined : value;
  }
  env.PRIME_AGENT_CODING_AGENT_DIR = plan.agentDir;
  env.PRIME_AGENT_TELEMETRY = "0";
  return { env: { ...ensurePathInEnv(env) }, droppedKeys: [...dropped].sort() };
};

// §16 A15

/** INTERFACES §16 A15/A16 (stub until WP1). Rejects with PrimeConfigError("prime_path_invalid") for a protected cwd. */
export async function assertPrimeCwdAllowed(_cwd: string): Promise<void> {
  return notImplemented("WP1", "assertPrimeCwdAllowed");
}
