# Credentials

Each agent's Prime dir gets its own `auth.json`. The server's ambient provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and the rest of `PRIME_PROVIDER_CREDENTIAL_ENV_KEYS` in `src/types.ts`) are removed from the child environment. Keys set in the agent's `env` are kept.

## host_auth (default)

`<agentDir>/auth.json` is a symlink to `hostAuthFile` (default `~/.prime/agent/auth.json` of the server user). It is re-created on every run if it is a stale copy, points elsewhere or dangles. Refresh tokens are single-use, so a copy goes stale. Prime writes refreshed tokens through the link to the real file.

The host file must be a regular file owned by the server user with mode 0600 (`chmod 600 ~/.prime/agent/auth.json`). The billing class is read from the provider entry's `type` only: `oauth` → subscription, `api_key` → api, anything else → unknown. Log in once with `prime-agent` as the server user.

## api_key

Set `"credentialMode": "api_key"`, `"apiKeyEnvVar": "ANTHROPIC_API_KEY"`, and bind `env.ANTHROPIC_API_KEY` to a Paperclip secret. Each run writes `{ "<provider>": { "type": "api_key", "key": "..." } }` for the model's provider to a 0600 temp file and renames it over `auth.json`. This replaces a link left from `host_auth`. The file is then re-checked. There is no provider-to-variable guessing: `apiKeyEnvVar` names the variable.

## Never

No fallback to the operator's `~/.prime/agent` as agent dir, to another provider or to another model. No key in logs, run results, session params or notes. A missing or unsafe credential fails before Prime starts: `prime_host_auth_missing`, `prime_host_auth_unsafe`, `prime_api_key_missing`, `prime_auth_file_unsafe`.

## Billing and cost

Usage tokens are reported when Prime reports them. `costUsd` is Prime's `usage.cost.total` only for api-key billing and only when > 0, else empty. Prime's cost on subscription runs is an estimate, not a charge.

## Several agents on one subscription

Observed on 2026-10-18 (prime-agent 0.10.0): two concurrent runs on one symlinked subscription succeeded; no token refresh happened during the smoke, so refresh serialization stays UNVERIFIED.

## Security

With `host_auth` every agent can read the host token through its link. Use `api_key` with a separate key per agent when that matters.
