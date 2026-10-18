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

function configCheckCode(err: unknown): PrimeCheckCode {
  const passThrough = ["prime_model_required", "prime_model_invalid", "prime_thinking_invalid"] as const;
  if (err instanceof PrimeConfigError && (passThrough as readonly string[]).includes(err.code)) return err.code as PrimeCheckCode;
  return "prime_config_invalid";
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

  let runtime: PrimeRuntimeConfig;
  try {
    runtime = resolvePrimeRuntimeConfig(ctx.config, { id: ENVIRONMENT_TEST_AGENT_ID, companyId: ctx.companyId }, resolvePaperclipInstanceRootForAdapter());
  } catch (err) {
    checks.push({ code: configCheckCode(err), level: "error", message: errorMessage(err) });
    return finish();
  }

  const cwd = runtime.cwd ?? process.cwd();
  try {
    await assertPrimeCwdAllowed(cwd);
    await ensureAbsoluteDirectory(cwd);
    checks.push({ code: "prime_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({ code: "prime_cwd_invalid", level: "error", message: errorMessage(err), detail: cwd });
    return finish();
  }

  let ephemeral: EphemeralPrimeAgentDir;
  try {
    ephemeral = await createEphemeralPrimeAgentDir(runtime.credential);
  } catch (err) {
    const code = err instanceof PrimeCredentialError ? err.code : "prime_agent_dir_unsafe";
    checks.push({ code, level: "error", message: errorMessage(err) });
    return finish();
  }
  try {
    const { env } = buildPrimeChildEnv(process.env, ephemeral.plan, runtime.env);
    const command = runtime.command;

    let cliFound = false;
    try {
      await ensureCommandResolvable(command, cwd, env);
      checks.push({ code: "prime_cli_found", level: "info", message: `Prime CLI found: ${await resolveCommandForLogs(command, cwd, env)}` });
      cliFound = true;
    } catch (err) {
      checks.push({ code: "prime_cli_missing", level: "error", message: errorMessage(err), detail: command });
    }

    let versionSupported = false;
    if (cliFound) {
      try {
        const version = await readPrimeVersion({ command, env, cwd });
        versionSupported = isSupportedPrimeVersion(version);
        if (versionSupported) {
          checks.push({ code: "prime_cli_version", level: "info", message: `prime-agent ${version}` });
        } else {
          const { min, maxExclusive } = PRIME_SUPPORTED_VERSION_RANGE;
          const message = `prime-agent ${version} is not supported; supported range is >= ${min} and < ${maxExclusive}.`;
          checks.push({ code: "prime_cli_version_unsupported", level: "error", message });
        }
      } catch (err) {
        const missing = err instanceof PrimeCliError && err.code === "prime_cli_missing";
        checks.push({ code: missing ? "prime_cli_missing" : "prime_cli_version_unreadable", level: "error", message: errorMessage(err), detail: command });
      }
    }

    // [wp5:next-step]
    return finish();
  } finally {
    await ephemeral.cleanup();
  }
}
