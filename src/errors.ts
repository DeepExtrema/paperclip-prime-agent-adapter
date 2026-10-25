/**
 * Frozen error types for the prime_agent_local adapter (WP0).
 * Thrown before spawn; execute maps them to errorCode "prime_preflight_failed"
 * and keeps the code in errorMeta.primeErrorCode.
 */

export type PrimeConfigErrorCode =
  | "prime_model_required"
  | "prime_model_invalid"
  | "prime_thinking_invalid"
  | "prime_credential_mode_invalid"
  | "prime_api_key_env_var_required"
  | "prime_path_invalid";

export class PrimeConfigError extends Error {
  readonly code: PrimeConfigErrorCode;

  constructor(code: PrimeConfigErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PrimeConfigError";
    this.code = code;
  }
}

export type PrimeCredentialErrorCode =
  /** host_auth: the host auth file is missing or a dangling link. */
  | "prime_host_auth_missing"
  /** host_auth: the host auth file is not a regular file owned by this uid with mode 0600. */
  | "prime_host_auth_unsafe"
  /** api_key: env[apiKeyEnvVar] is missing or empty. */
  | "prime_api_key_missing"
  /** api_key: the written auth.json failed the re-check (not regular, not 0600, wrong owner, symlink). */
  | "prime_auth_file_unsafe"
  /** The agent dir is unsafe (symlink, wrong owner, overlaps a protected path). */
  | "prime_agent_dir_unsafe";

export class PrimeCredentialError extends Error {
  readonly code: PrimeCredentialErrorCode;

  constructor(code: PrimeCredentialErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PrimeCredentialError";
    this.code = code;
  }
}

export type PrimeCliErrorCode =
  | "prime_cli_missing"
  | "prime_cli_version_unsupported"
  | "prime_cli_version_unreadable"
  | "prime_model_list_failed"
  | "prime_model_unknown";

export class PrimeCliError extends Error {
  readonly code: PrimeCliErrorCode;

  constructor(code: PrimeCliErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PrimeCliError";
    this.code = code;
  }
}

/** TAI-225 rev 3 §9. Unlike the classes above, execute reports `code` itself as the run's errorCode. */
export type PrimePolicyErrorCode =
  /** settings.json exists but is not a JSON object (or cannot be read). The adapter does not write it. */
  | "prime_settings_invalid"
  /** allowedModels or modelRoles is malformed, or the model or a role is outside allowedModels. */
  | "prime_allowed_models_invalid"
  /** A managed settings key differs after the run from what the adapter wrote. */
  | "prime_settings_tampered"
  /** api_key mode: after the run auth.json is not a regular 0600 file holding only the configured provider. */
  | "prime_auth_tampered"
  /** An actor ran a model outside allowedModels, or an actor's model could not be read. */
  | "prime_model_audit_failed"
  /** TAI-273 §3.2: fail closed on the managed Claude subscription connection, before any file is written. */
  | "prime_managed_connection_invalid"
  /** TAI-273 §3.2: auth.json could not be deleted after a managed_subscription run. */
  | "prime_auth_cleanup_failed"
  /** TAI-273 §2.2: featureProfile or maxSubagentsPerRun is invalid, or governed-v1 lacks allowedModels, daemon or its credential modes. */
  | "prime_feature_profile_invalid"
  /** TAI-273 §2.2 item 10: the parent's skill list is not exactly the explicit list, or a session ended for its skills ran again. */
  | "prime_skill_list_invalid"
  /** TAI-273 §2.2 item 12: an allowed model is missing from the catalog, has another Anthropic address or no reasoning, or the thinking level did not take. */
  | "prime_model_catalog_invalid";

export class PrimePolicyError extends Error {
  readonly code: PrimePolicyErrorCode;

  constructor(code: PrimePolicyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PrimePolicyError";
    this.code = code;
  }
}

/** Thrown by WP0 stubs until the owning work package lands. */
export function notImplemented(wp: string, what: string): never {
  throw new Error(`not implemented (${wp}): ${what}`);
}
