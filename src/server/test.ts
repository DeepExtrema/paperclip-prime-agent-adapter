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
import { resolvePrimeNativeConfig } from "./execute-daemon.js";
import {
  checkPrimeManagedConfig, hasPrimeManagedBinding, primeManagedRegistration, primeManagedToken, resolvePrimeManagedConnection,
} from "./managed-connection.js";
import { resolvePrimeModelPolicy, type PrimeModelPolicy } from "./model-policy.js";
import { assertPrimeModelListed, listPrimeModels } from "./models.js";
import {
  assertPrimeCwdAllowed,
  buildPrimeChildEnv,
  createEphemeralPrimeAgentDir,
  inspectHostAuth,
  resolvePrimeCommand,
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

function credentialCheckCode(err: unknown): PrimeCheckCode {
  const missing = err instanceof PrimeCredentialError && (err.code === "prime_host_auth_missing" || err.code === "prime_api_key_missing");
  return missing ? "prime_auth_missing" : "prime_auth_unsafe";
}

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
  let policy: PrimeModelPolicy;
  try {
    runtime = resolvePrimeRuntimeConfig(ctx.config, { id: ENVIRONMENT_TEST_AGENT_ID, companyId: ctx.companyId }, resolvePaperclipInstanceRootForAdapter());
    policy = resolvePrimeModelPolicy(ctx.config, runtime, resolvePrimeNativeConfig(ctx.config)); // TAI-225 §9: allowedModels and modelRoles
  } catch (err) {
    checks.push({ code: configCheckCode(err), level: "error", message: errorMessage(err) });
    return finish();
  }
  // TAI-273 §3.2: the registration record, the fail-closed rule, and checks 1-3 when the body carries the token. No hello probe.
  const managed = runtime.credential.mode === "managed_subscription";
  if (managed) {
    const { registered, message } = primeManagedRegistration();
    checks.push({ code: registered ? "prime_auth_managed_registered" : "prime_auth_managed_unregistered", level: registered ? "info" : "error", message });
  }
  if (managed || hasPrimeManagedBinding(ctx.config)) {
    const carried = hasPrimeManagedBinding(ctx.config) || primeManagedToken(ctx.config) !== undefined;
    const input = { mode: runtime.credential.mode, provider: runtime.provider, allowedModels: policy.allowedModels };
    try {
      if (carried) {
        resolvePrimeManagedConnection(ctx.config, input);
        if (managed) checks.push({ code: "prime_auth_managed_token_ok", level: "info", message: "The managed Claude subscription token matches the connection identity (value not shown). Only a run proves Anthropic accepts it." });
      } else {
        checkPrimeManagedConfig(ctx.config, input);
      }
    } catch (err) {
      checks.push({ code: "prime_managed_connection_invalid", level: "error", message: errorMessage(err) });
      return finish();
    }
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
    const command = await resolvePrimeCommand(runtime.command, env);

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

    let credentialReady = false;
    try {
      if (runtime.credential.mode === "managed_subscription") {
        // Checked above; the token is never written to a temporary dir.
      } else if (runtime.credential.mode === "api_key") {
        await seedPrimeAgentDir(ephemeral.plan, { provider: runtime.provider, env: runtime.env });
        const message = `API key from env var ${runtime.credential.apiKeyEnvVar} is set (value not shown).`;
        checks.push({ code: "prime_auth_api_key", level: "info", message });
      } else {
        // TAI-225 §9 item 8: the host login is checked in place and never linked into the temp dir.
        const billingType = await inspectHostAuth(runtime.credential.hostAuthFile, runtime.provider);
        const message = `Host Prime auth file is present and safe (billing: ${billingType}).`;
        checks.push({ code: "prime_auth_host_linked", level: "info", message });
      }
      credentialReady = true;
    } catch (err) {
      checks.push({ code: credentialCheckCode(err), level: "error", message: errorMessage(err) });
    }

    if (!cliFound || !versionSupported || !credentialReady) return finish();
    if (managed) {
      const message = "Model listing skipped: the managed Claude subscription token is written to the agent's own Prime dir only during a run. The first run checks the model.";
      checks.push({ code: "prime_models_skipped", level: "info", message });
      return finish();
    }
    if (runtime.credential.mode === "host_auth") {
      const message = "Model listing skipped: the host Prime login is never linked into a temporary dir (Prime 0.10 replaces the link when it refreshes). The first run checks the model.";
      checks.push({ code: "prime_models_skipped", level: "info", message });
      return finish();
    }

    let models: AdapterModel[];
    try {
      models = await listPrimeModels({ command, env, cwd });
    } catch (err) {
      checks.push({ code: "prime_models_discovery_failed", level: "warn", message: errorMessage(err) });
      return finish();
    }
    if (models.length === 0) {
      const hint = "Run `prime-agent model list` with this credential and check the provider login.";
      checks.push({ code: "prime_models_empty", level: "warn", message: "Prime listed no models for the configured credential.", hint });
      return finish();
    }
    checks.push({ code: "prime_models_discovered", level: "info", message: `Prime listed ${models.length} model(s) for the configured credential.` });

    try {
      assertPrimeModelListed(runtime.modelRef, models);
      checks.push({ code: "prime_model_listed", level: "info", message: `${runtime.modelRef} is listed; entitlement is proven only by a run.` });
    } catch (err) {
      checks.push({ code: "prime_model_unknown", level: "error", message: errorMessage(err) });
    }
    return finish();
  } finally {
    await ephemeral.cleanup();
  }
}
