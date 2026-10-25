// TAI-273 plan rev 11 §2.2 (G6): featureProfile "governed-v1", its config rules and its managed settings keys.
import { PrimePolicyError } from "../errors.js";

export const PRIME_FEATURE_PROFILE = "governed-v1";

export interface PrimeFeatureProfile {
  profile: typeof PRIME_FEATURE_PROFILE;
  /** Sessions other than the parent, at any depth, per run (item 2). 1-8, default 2. */
  maxSubagentsPerRun: number;
  /** adapterConfig.rlmMaxDepth, default 1 (item 1). */
  rlmMaxDepth: number;
  /** adapterConfig.thinking, required (rev 11): item 12's step and the managed defaultThinkingLevel need it. "off" is allowed. */
  thinking: string;
}

/** Item 5: the keys a run may leave in settings.json besides the managed keys. */
export const PRIME_DISPLAY_ONLY_SETTINGS_KEYS = ["onboardingShown", "onboardingCompleted", "recentModels", "quietStartup", "theme"] as const;
/** Item 5 (agreed at the N0 checkpoint): a run that adds one of these fails with prime_settings_tampered. defaultThinkingLevel is a managed key (rev 11). */
export const PRIME_DANGEROUS_SETTINGS_KEYS = [
  "shellPath", "shellCommandPrefix", "npmCommand", "mcpServers", "mcpCatalogSources", "packages", "prompts", "sessionDir", "autonomous",
  "extensions", "enableSkillCommands", "bundledSkills", "updateChannel", "transport", "defaultServiceTier",
  "thinkingBudgets", "compaction", "branchSummary", "idleEvictionMinutes", "steeringMode", "followUpMode", "images", "requestTiming",
] as const;

const DEFAULT_MAX_SUBAGENTS = 2;
const DEFAULT_RLM_MAX_DEPTH = 1;
const isUnset = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const invalid = (message: string): never => {
  throw new PrimePolicyError("prime_feature_profile_invalid", message);
};

/** Before any file is written. Throws PrimePolicyError("prime_feature_profile_invalid"). */
export function resolvePrimeFeatureProfile(
  config: Record<string, unknown>,
  input: { runtime: "daemon" | "print"; credentialMode: string; allowedModels: string[] | null; rlmMaxDepth: number | null; thinking: string | null },
): PrimeFeatureProfile | null {
  const value = config.featureProfile;
  if (isUnset(value)) {
    if (!isUnset(config.maxSubagentsPerRun)) invalid(`adapterConfig.maxSubagentsPerRun needs featureProfile "${PRIME_FEATURE_PROFILE}".`);
    return null;
  }
  if (value !== PRIME_FEATURE_PROFILE) invalid(`adapterConfig.featureProfile must be "${PRIME_FEATURE_PROFILE}".`);
  if (input.allowedModels === null) invalid(`featureProfile "${PRIME_FEATURE_PROFILE}" needs adapterConfig.allowedModels.`);
  if (input.runtime !== "daemon") invalid(`featureProfile "${PRIME_FEATURE_PROFILE}" needs runtime "daemon".`);
  if (input.credentialMode !== "managed_subscription" && input.credentialMode !== "api_key") {
    invalid(`featureProfile "${PRIME_FEATURE_PROFILE}" needs credentialMode managed_subscription or api_key, never host_auth.`);
  }
  if (input.thinking === null) invalid(`featureProfile "${PRIME_FEATURE_PROFILE}" needs adapterConfig.thinking ("off" is allowed).`);
  const raw = config.maxSubagentsPerRun;
  const parsed = isUnset(raw) ? DEFAULT_MAX_SUBAGENTS : typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) invalid("adapterConfig.maxSubagentsPerRun must be an integer from 1 to 8.");
  return { profile: PRIME_FEATURE_PROFILE, maxSubagentsPerRun: parsed, rlmMaxDepth: input.rlmMaxDepth ?? DEFAULT_RLM_MAX_DEPTH, thinking: input.thinking! };
}

/** Items 1 and 10: whole top-level values, written before each run and checked after it. */
export function primeGovernedManagedKeys(profile: PrimeFeatureProfile): Record<string, unknown> {
  return {
    harnessRefinements: true,
    autoRefine: { enabled: false },
    factory: { enabled: false },
    rlmMaxDepth: profile.rlmMaxDepth,
    retry: { provider: { waitForUsage: { enabled: false, pauseUntilReset: false } } },
    agentTraces: { enabled: false },
    telemetry: { enabled: false },
    skills: ["!**"], // item 10: drops the agent dir's skills, $HOME/.agents/skills/ and settings skill paths
    enableBuiltinSkills: false, // item 10: the allowlisted built-ins come by path in the create config
    // Item 1 (rev 11): Prime writes this whenever set_thinking_level changes the level, and set_model may restore from it.
    defaultThinkingLevel: profile.thinking,
  };
}
