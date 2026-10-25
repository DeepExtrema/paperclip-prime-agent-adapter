// TAI-273 plan rev 7 §3.2 (C1): Prime runs on the host's managed Claude subscription connection.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { PrimePolicyError } from "../errors.js";
import { PRIME_ADAPTER_TYPE } from "../types.js";
import { checkPrimeAuth } from "./model-policy.js";

/** The only env key the host puts the subscription token in (plan F2). */
export const PRIME_MANAGED_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** The host's own module instance: scripts/link-adapter-utils.mjs links @paperclipai/shared from the running install. */
const SHARED_AI_CONNECTIONS = "@paperclipai/shared/ai-connections";
const BINDING_MESSAGE = "This agent has a Paperclip AI connection. Set credentialMode to managed_subscription, or remove the connection.";

export interface PrimeManagedRegistration {
  /** The shared array the host's select() reads now holds prime_agent_local. */
  registered: boolean;
  message: string;
}

let registration: PrimeManagedRegistration = { registered: false, message: "Registration has not run." };

/** Adds prime_agent_local to the anthropic subscription method only. No api_key method, no other provider. */
export async function registerPrimeManagedConnection(load: () => Promise<unknown> = () => import(SHARED_AI_CONNECTIONS)): Promise<PrimeManagedRegistration> {
  try {
    const shared = (await load()) as { AI_CONNECTION_CAPABILITIES?: { anthropic?: { methods?: { subscription?: { adapters?: unknown } } } } };
    const adapters = shared.AI_CONNECTION_CAPABILITIES?.anthropic?.methods?.subscription?.adapters;
    if (!Array.isArray(adapters)) {
      registration = { registered: false, message: `${SHARED_AI_CONNECTIONS} has no anthropic subscription adapter list.` };
    } else {
      if (!adapters.includes(PRIME_ADAPTER_TYPE)) adapters.push(PRIME_ADAPTER_TYPE);
      registration = adapters.includes(PRIME_ADAPTER_TYPE)
        ? { registered: true, message: `${PRIME_ADAPTER_TYPE} is registered for the anthropic subscription connection.` }
        : { registered: false, message: `${SHARED_AI_CONNECTIONS} refused the registration.` };
    }
  } catch (err) {
    registration = { registered: false, message: `Cannot load ${SHARED_AI_CONNECTIONS}: ${err instanceof Error ? err.message : String(err)}. Link @paperclipai/shared from the running Paperclip install.` };
  }
  return registration;
}

export const primeManagedRegistration = (): PrimeManagedRegistration => registration;

await registerPrimeManagedConnection();

export interface PrimeManagedBinding {
  connectionId: string | null;
  /** Last ":"-segment of the binding identity: sha256(token) hex, first 16 characters. Not a secret. */
  identitySuffix: string;
}

const invalid = (message: string): never => {
  throw new PrimePolicyError("prime_managed_connection_invalid", message);
};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks 2 and 3: the token shape and its match with the binding identity. Throws prime_managed_connection_invalid. */
export function checkPrimeManagedToken(binding: unknown, token: unknown): PrimeManagedBinding {
  if (!isObject(binding) || binding.provider !== "anthropic" || binding.method !== "subscription"
    || typeof binding.identity !== "string" || binding.identity.trim() === "") {
    return invalid("credentialMode managed_subscription needs the host's Anthropic subscription connection (managedAiConnection with provider anthropic, method subscription and an identity).");
  }
  if (typeof token !== "string" || !token.startsWith("sk-ant-oat")) {
    return invalid(`credentialMode managed_subscription: env ${PRIME_MANAGED_TOKEN_ENV} does not hold a Claude subscription token.`);
  }
  const identitySuffix = binding.identity.split(":").at(-1)!;
  if (createHash("sha256").update(token).digest("hex").slice(0, 16) !== identitySuffix) {
    return invalid(`credentialMode managed_subscription: the token in ${PRIME_MANAGED_TOKEN_ENV} does not match the connection identity.`);
  }
  return { connectionId: typeof binding.connectionId === "string" ? binding.connectionId : null, identitySuffix };
}

export const hasPrimeManagedBinding = (config: Record<string, unknown>): boolean =>
  config.managedAiConnection !== undefined && config.managedAiConnection !== null;
export const primeManagedToken = (config: Record<string, unknown>): unknown => (isObject(config.env) ? config.env[PRIME_MANAGED_TOKEN_ENV] : undefined);

/** The config part of the rule: governed-v1 (rev 6) and check 4. Throws prime_managed_connection_invalid. */
export function checkPrimeManagedConfig(config: Record<string, unknown>, input: { provider: string; allowedModels: string[] | null }): void {
  if (config.featureProfile !== "governed-v1") invalid('credentialMode managed_subscription needs featureProfile "governed-v1".');
  if (input.provider !== "anthropic") invalid("credentialMode managed_subscription needs an anthropic/… model.");
  if (input.allowedModels === null) invalid("credentialMode managed_subscription needs adapterConfig.allowedModels.");
}

/**
 * The fail-closed rule, before any file is written. Returns the binding for managed_subscription, else null.
 * Throws PrimePolicyError("prime_managed_connection_invalid").
 */
export function resolvePrimeManagedConnection(
  config: Record<string, unknown>,
  input: { mode: string; provider: string; allowedModels: string[] | null },
): PrimeManagedBinding | null {
  if (input.mode !== "managed_subscription") return hasPrimeManagedBinding(config) ? invalid(BINDING_MESSAGE) : null;
  checkPrimeManagedConfig(config, input);
  return checkPrimeManagedToken(config.managedAiConnection, primeManagedToken(config));
}

/**
 * §3.2 "After the run, in a finally": the auth.json check, its delete and resultJson.credential, on every path after the write.
 * preflight: the run failed before Prime started; a tampered file is then logged and the preflight error stays the run's error.
 * On the run path the tamper check is finishPrimeRun's (prime_auth_tampered).
 */
export async function finishPrimeManagedCredential(
  result: AdapterExecutionResult,
  input: { agentDir: string; binding: PrimeManagedBinding; preflight: boolean; onLog: (line: string) => Promise<void> },
): Promise<AdapterExecutionResult> {
  const authFile = path.join(input.agentDir, "auth.json");
  if (input.preflight) {
    const check = await checkPrimeAuth(input.agentDir, "anthropic");
    if (!check.ok && (await fs.lstat(authFile).catch(() => null))) await input.onLog(`[paperclip] auth.json before Prime started ${check.problem}.\n`);
  }
  const credential = { mode: "managed_subscription", connectionId: input.binding.connectionId, identitySuffix: input.binding.identitySuffix };
  const withCredential = { ...result, resultJson: { ...(result.resultJson ?? {}), credential } };
  try {
    await fs.rm(authFile, { force: true });
    return withCredential;
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    await input.onLog(`[paperclip] Could not delete ${authFile} (${reason}); it holds the managed Claude subscription token.\n`);
    const { sessionId: _id, sessionParams: _params, sessionDisplayId: _display, ...rest } = withCredential;
    return {
      ...rest, exitCode: result.exitCode === 0 || result.exitCode === null ? 1 : result.exitCode,
      errorCode: "prime_auth_cleanup_failed", errorMessage: `Could not delete ${authFile} after the run (${reason}).`,
      errorMeta: { ...result.errorMeta, primeErrorCode: "prime_auth_cleanup_failed", runErrorCode: result.errorCode ?? null, runErrorMessage: result.errorMessage ?? null },
    };
  }
}
