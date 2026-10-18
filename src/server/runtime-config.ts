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
export const seedPrimeAgentDir: SeedPrimeAgentDir = async () => notImplemented("WP1", "seedPrimeAgentDir");

export const createEphemeralPrimeAgentDir: CreateEphemeralPrimeAgentDir = async () =>
  notImplemented("WP1", "createEphemeralPrimeAgentDir");

// §4 buildPrimeChildEnv
export const buildPrimeChildEnv: BuildPrimeChildEnv = () => notImplemented("WP1", "buildPrimeChildEnv");

// §16 A15

/** INTERFACES §16 A15/A16 (stub until WP1). Rejects with PrimeConfigError("prime_path_invalid") for a protected cwd. */
export async function assertPrimeCwdAllowed(_cwd: string): Promise<void> {
  return notImplemented("WP1", "assertPrimeCwdAllowed");
}
