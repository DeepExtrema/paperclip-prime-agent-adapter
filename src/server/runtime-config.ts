// Owner: WP1. Contract: INTERFACES.md §2-§4. Replace the stub bodies; keep the typed exports.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  asBoolean, asNumber, asStringArray, ensurePathInEnv, parseObject, resolvePaperclipInstanceRootForAdapter,
  sanitizeInheritedPaperclipEnv,
} from "@paperclipai/adapter-utils/server-utils";
import { PrimeConfigError, PrimeCredentialError } from "../errors.js";
import {
  PRIME_ADAPTER_OWNED_ENV_KEYS, PRIME_ALWAYS_STRIPPED_ENV_PREFIXES, PRIME_DEFAULT_COMMAND,
  PRIME_THINKING_LEVELS, type BuildPrimeChildEnv, type CreateEphemeralPrimeAgentDir,
  type PrimeCredentialConfig, type PrimeThinkingLevel, type ResolvePrimeRuntimeConfig, type SeedPrimeAgentDir,
  type SeededPrimeAgentDir,
} from "../types.js";

/** Resolves the server-side model discovery command without changing execute's child-PATH lookup. */
export async function resolvePrimeDefaultCommand(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  for (const entry of env.PATH?.split(path.delimiter) ?? []) {
    try {
      await fs.access(path.join(entry, PRIME_DEFAULT_COMMAND), fs.constants.X_OK);
      return PRIME_DEFAULT_COMMAND;
    } catch {
      // Keep searching PATH before trying the user-local install.
    }
  }
  const fallback = path.join(os.homedir(), ".local", "bin", PRIME_DEFAULT_COMMAND);
  try {
    await fs.access(fallback, fs.constants.X_OK);
    return fallback;
  } catch {
    return PRIME_DEFAULT_COMMAND;
  }
}

/** The configured command as-is; the bare default is resolved against the child PATH, then the user-local install. */
export async function resolvePrimeCommand(command: string, childEnv: NodeJS.ProcessEnv): Promise<string> {
  return command === PRIME_DEFAULT_COMMAND ? resolvePrimeDefaultCommand(childEnv) : command;
}

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
  const thinking = parseThinking([config.thinking, config.effort, config.thinkingEffort].find((value) => value !== undefined)); // §16 A21
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
    // The bare default is resolved per call site with resolvePrimeCommand (child PATH, then the user-local install).
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
/** Reduced salvage §2.4 list: INTERFACES §3 home entries; instance dirs from Paperclip packages/shared/src/home-paths.ts. */
const PROTECTED_HOME_ENTRIES = [".prime", ".pi", ".codex", ".claude", ".ssh", ".gnupg", ".aws", ".config"];
const PROTECTED_INSTANCE_ENTRIES = ["secrets", "db", path.join("data", "backups"), "logs"];
function unsafeAgentDir(message: string, cause?: unknown): never {
  throw new PrimeCredentialError("prime_agent_dir_unsafe", message, cause === undefined ? undefined : { cause });
}

function isSameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function protectedPaths(): string[] {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter();
  return [
    ...PROTECTED_HOME_ENTRIES.map((entry) => path.join(os.homedir(), entry)),
    ...PROTECTED_INSTANCE_ENTRIES.map((entry) => path.join(instanceRoot, entry)),
  ];
}

/** Real path of the longest existing prefix, with the missing rest appended. */
async function canonicalPath(target: string): Promise<string> {
  const missing: string[] = [];
  let existing = target;
  for (;;) {
    try {
      return path.join(await fs.realpath(existing), ...missing);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

async function assertAgentDirLocation(agentDir: string): Promise<void> {
  if (!path.isAbsolute(agentDir) || path.normalize(agentDir) !== agentDir) {
    unsafeAgentDir(`Prime agent dir must be an absolute, normalized path: ${agentDir}`);
  }
  const realAgentDir = await canonicalPath(agentDir);
  for (const protectedPath of await Promise.all(protectedPaths().map(canonicalPath))) {
    if (isSameOrInside(realAgentDir, protectedPath) || isSameOrInside(protectedPath, realAgentDir)) {
      unsafeAgentDir(`Prime agent dir ${agentDir} (real path ${realAgentDir}) overlaps protected path ${protectedPath}.`);
    }
  }
}

async function ensurePrivateDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    unsafeAgentDir(`Cannot create Prime agent dir ${dir}.`, err);
  }
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.()) {
    unsafeAgentDir(`${dir} must be a real directory owned by this user, not a symlink.`);
  }
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
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno !== "ENOENT" && errno !== "ENOTDIR") {
      throw new PrimeCredentialError("prime_host_auth_unsafe", `Cannot read host Prime auth file ${hostAuthFile} (${errno ?? "unknown errno"}).`, { cause: err });
    }
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

/** host_auth checks without linking anything (environment test). Throws PrimeCredentialError as seedPrimeAgentDir does. */
export async function inspectHostAuth(hostAuthFile: string, provider: string): Promise<SeededPrimeAgentDir["billingType"]> {
  await assertHostAuthFile(hostAuthFile);
  return readHostBillingType(hostAuthFile, provider);
}

export const seedPrimeAgentDir: SeedPrimeAgentDir = async (plan, input) => {
  await assertAgentDirLocation(plan.agentDir);
  await ensurePrivateDir(plan.agentDir);
  await ensurePrivateDir(plan.sessionDir);
  const authFile = path.join(plan.agentDir, "auth.json");
  if ((await fs.lstat(authFile).catch(() => null))?.isDirectory()) {
    unsafeAgentDir(`${authFile} is a directory.`);
  }
  const notes = [`Prime agent dir: ${plan.agentDir} (${plan.kind}).`];
  const credential = plan.credential;
  if (credential.mode === "host_auth") {
    // TAI-225 §9 item 8: Prime 0.10 replaces the link with a regular file when it refreshes the token, and a temp dir
    // is then deleted with the only copy of the new token. The host login is linked into durable agent dirs only.
    if (plan.kind !== "agent") unsafeAgentDir(`The host Prime login is never linked into a temporary agent dir (${plan.agentDir}).`);
    await assertHostAuthFile(credential.hostAuthFile);
    await linkHostAuth(authFile, credential.hostAuthFile);
    notes.push(`auth.json -> ${credential.hostAuthFile} (host Prime credential).`);
    const billingType = await readHostBillingType(credential.hostAuthFile, input.provider);
    return { plan, auth: "host_auth_symlink", billingType, notes };
  }
  const key = (input.env[credential.apiKeyEnvVar] ?? "").trim();
  if (key === "") {
    const message = `Environment variable ${credential.apiKeyEnvVar} is unset or empty; it must hold the ${credential.provider} API key.`;
    throw new PrimeCredentialError("prime_api_key_missing", message);
  }
  const content = `${JSON.stringify({ [credential.provider]: { type: "api_key", key } })}\n`;
  await replaceAuthFile(authFile, (temp) => fs.writeFile(temp, content, { flag: "wx", mode: 0o600 }));
  const written = await fs.lstat(authFile);
  if (written.isSymbolicLink() || !isPrivateRegularFile(written)) {
    throw new PrimeCredentialError("prime_auth_file_unsafe", `${authFile} must be a regular file owned by this user with mode 0600.`);
  }
  // TAI-225 §9 item 6: a Claude subscription token (`claude setup-token`) is billed to the subscription, not per call.
  const billingType = key.startsWith("sk-ant-oat") ? "subscription" : "api";
  notes.push(`auth.json written from ${credential.apiKeyEnvVar} for provider ${credential.provider} (billing: ${billingType}).`);
  return { plan, auth: "api_key_file", billingType, notes };
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

const BASE_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TERM", "TMPDIR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "PAPERCLIP_RUNTIME_API_URL", "PAPERCLIP_LISTEN_HOST", "PAPERCLIP_LISTEN_PORT",
]);
const OWNED_KEYS: readonly string[] = PRIME_ADAPTER_OWNED_ENV_KEYS;

/** Stripped keys stay as explicit undefined: runChildProcess merges process.env first, then deletes undefined keys (§16 A8). */
export const buildPrimeChildEnv: BuildPrimeChildEnv = (base, plan, paperclipEnv) => {
  const dropped = new Set<string>();
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(sanitizeInheritedPaperclipEnv(base))) { // §16 A17: no server PAPERCLIP_* secrets
    if (value === undefined) continue;
    const strip = !BASE_ENV_KEYS.has(key) && !hasPrefix(key, ["LC_", "XDG_"]); // §16 A22
    if (strip) dropped.add(key);
    env[key] = strip ? undefined : value;
  }
  // TAI-225 §9 item 7: the api_key value reaches Prime only through auth.json, never through the kernel's or bash's environment.
  const apiKeyEnvVar = plan.credential.mode === "api_key" ? plan.credential.apiKeyEnvVar : null;
  for (const [key, value] of Object.entries(paperclipEnv)) {
    const strip = hasPrefix(key, PRIME_ALWAYS_STRIPPED_ENV_PREFIXES) || OWNED_KEYS.includes(key) || key === apiKeyEnvVar;
    if (strip) dropped.add(key);
    env[key] = strip ? undefined : value;
  }
  env.PRIME_AGENT_CODING_AGENT_DIR = plan.agentDir;
  env.PRIME_AGENT_TELEMETRY = "0";
  return { env: { ...ensurePathInEnv(env) }, droppedKeys: [...dropped].sort() };
};

// §16 A15

/** §16 A15 (corrected): refuse an execution cwd inside ~/.prime/agent or Paperclip state, before any mkdir.
 * Paperclip state = the Paperclip home (resolved and ~/.paperclip) except <instanceRoot>/workspaces/* and projects/*.
 * HOME and the instance root are read on every call (never at import time): tests and WP3 change HOME at runtime. Real paths. */
export async function assertPrimeCwdAllowed(cwd: string): Promise<void> {
  if (!path.isAbsolute(cwd)) throw new PrimeConfigError("prime_path_invalid", `cwd must be an absolute path: ${cwd}`);
  const instanceRoot = resolvePaperclipInstanceRootForAdapter();
  const [realCwd, primeAgentDir, ...paperclipHomes] = await Promise.all(
    [cwd, path.join(os.homedir(), ".prime", "agent"), path.dirname(path.dirname(instanceRoot)), path.join(os.homedir(), ".paperclip")].map(canonicalPath),
  );
  const workspaceRoots = await Promise.all(["workspaces", "projects"].map((entry) => canonicalPath(path.join(instanceRoot, entry))));
  const inWorkspace = workspaceRoots.some((root) => realCwd !== root && isSameOrInside(realCwd, root));
  const refused = isSameOrInside(realCwd, primeAgentDir) || (!inWorkspace && paperclipHomes.some((home) => isSameOrInside(realCwd, home)));
  if (refused) {
    throw new PrimeConfigError("prime_path_invalid", `cwd ${cwd} (real path ${realCwd}) is inside Prime or Paperclip state.`);
  }
}
