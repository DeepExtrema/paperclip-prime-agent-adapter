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

/** Thrown by WP0 stubs until the owning work package lands. */
export function notImplemented(wp: string, what: string): never {
  throw new Error(`not implemented (${wp}): ${what}`);
}
