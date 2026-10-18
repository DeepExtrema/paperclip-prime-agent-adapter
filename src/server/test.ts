// Owner: WP5. Contract: INTERFACES.md §10.
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult, AdapterModel } from "@paperclipai/adapter-utils";
import {
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  resolveCommandForLogs,
  resolvePaperclipInstanceRootForAdapter,
} from "@paperclipai/adapter-utils/server-utils";
import { PrimeCliError, PrimeConfigError, PrimeCredentialError, type PrimeCredentialErrorCode } from "../errors.js";
import { PRIME_SUPPORTED_VERSION_RANGE, type EphemeralPrimeAgentDir, type PrimeCheckCode, type PrimeRuntimeConfig } from "../types.js";
import { assertPrimeModelListed, listPrimeModels } from "./models.js";
import {
  assertPrimeCwdAllowed,
  buildPrimeChildEnv,
  createEphemeralPrimeAgentDir,
  resolvePrimeRuntimeConfig,
  seedPrimeAgentDir,
} from "./runtime-config.js";
import { isSupportedPrimeVersion, readPrimeVersion } from "./version.js";

/** testEnvironment has no agent; this id only satisfies resolvePrimeRuntimeConfig. Its agent dir is never used. */
const ENVIRONMENT_TEST_AGENT_ID = "environment-test";

/** Parent ruling: an ephemeral-dir failure reports the PrimeCredentialError code (not in PRIME_CHECK_CODES). */
type PrimeCheck = AdapterEnvironmentCheck & { code: PrimeCheckCode | PrimeCredentialErrorCode };

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((entry) => entry.level === "error")) return "fail";
  if (checks.some((entry) => entry.level === "warn")) return "warn";
  return "pass";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// [wp5:helpers]

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: PrimeCheck[] = [];
  const finish = (): AdapterEnvironmentTestResult => ({
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  });

  const target = ctx.executionTarget ?? null;
  if (target !== null && target.kind !== "local") {
    checks.push({ code: "prime_config_invalid", level: "error", message: "remote execution targets are not supported in phase 1" });
    return finish();
  }

  // [wp5:next-step]
  return finish();
}
