import {buildAdapterEnvConfig, type CreateConfigValues} from "@paperclipai/adapter-utils";

function splitArgs(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function nonEmptyString(value: unknown): string|null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const PRIME_NATIVE_SCHEMA_KEYS = [
  "runtime",
  "goal",
  "goalTokenBudget",
  "autonomous",
  "autonomousMaxTurns",
  "autonomousMaxTokens",
  "autonomousMaxContinuations",
  "autonomousTimeoutMs",
  "autonomousGates",
  "autonomousGateRetries",
  "autonomousGateTimeoutMs",
  "rlmMaxDepth",
  "subagentDefaultModel",
] as const;
/** pi-local build-config.ts shape plus the two Prime credential fields (INTERFACES.md §12). */
export function buildPrimeLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd)
    ac.cwd = v.cwd;
  if (v.instructionsFilePath)
    ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model)
    ac.model = v.model;
  if (v.thinkingEffort)
    ac.thinking = v.thinkingEffort;
  ac.timeoutSec = 0;
  ac.graceSec = 20;
  const env = buildAdapterEnvConfig(v.envBindings, v.envVars);
  if (Object.keys(env).length > 0)
    ac.env = env;
  if (v.command)
    ac.command = v.command;
  const extraArgs = splitArgs(v.extraArgs ?? "");
  if (extraArgs.length > 0)
    ac.extraArgs = extraArgs;
  const args = splitArgs(v.args ?? "");
  if (args.length > 0)
    ac.args = args;
  const credentialMode = nonEmptyString(v.adapterSchemaValues?.credentialMode);
  if (credentialMode)
    ac.credentialMode = credentialMode;
  const apiKeyEnvVar = nonEmptyString(v.adapterSchemaValues?.apiKeyEnvVar);
  if (apiKeyEnvVar)
    ac.apiKeyEnvVar = apiKeyEnvVar;
  for (const key of PRIME_NATIVE_SCHEMA_KEYS) {
    const value = v.adapterSchemaValues?.[key];
    if (typeof value === "boolean" || typeof value === "number")
      ac[key] = value;
    else if (nonEmptyString(value))
      ac[key] = key === "goal" || key === "autonomousGates" ? value : nonEmptyString(value);
  }
  return ac;
}
