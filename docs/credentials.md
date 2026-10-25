# Credentials

Each agent's Prime dir gets its own `auth.json`. The inherited server environment uses the allowlist in [configuration](configuration.md#environment) (INTERFACES §16 A22). All other inherited server variables, including provider keys such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, are removed. Provider keys for `api_key` mode come from config `env`, applied on top of the allowlisted base with the Paperclip run environment and adapter keys.

## host_auth (default)

`<agentDir>/auth.json` is a symlink to `hostAuthFile` (default `~/.prime/agent/auth.json` of the server user). It is re-created on every run if it is a stale copy, points elsewhere or dangles. Refresh tokens are single-use, so a copy goes stale.

### host_auth unsafe with Prime 0.10

The link does not survive a token refresh. Prime 0.10 writes `auth.json` by renaming a temp file into the agent dir, which replaces the link with a regular file. After the first refresh the agent dir holds the new token, the host file keeps the spent refresh token, and the host login is signed out (found by reading the 0.10.1 binary; not reproduced in a live run). The next run then re-links the host file and drops the agent's new token. Do not use `host_auth` with Prime 0.10 for agents that run long enough to refresh. Use `api_key`.

The adapter links the host login only into durable agent dirs at run time. The environment test checks the host file in place and lists no models (`prime_models_skipped`). The UI model list uses a placeholder key in a temp dir (see [troubleshooting](troubleshooting.md#other-symptoms)). No code path links the host login into a temp dir.

The host file must be a regular file owned by the server user with mode 0600 (`chmod 600 ~/.prime/agent/auth.json`). The billing class is read from the provider entry's `type` only: `oauth` → subscription, `api_key` → api, anything else → unknown. Log in once with `prime-agent` as the server user.

## api_key

Set `"credentialMode": "api_key"`, `"apiKeyEnvVar": "ANTHROPIC_API_KEY"`, and bind `env.ANTHROPIC_API_KEY` to a Paperclip secret. Each run writes `{ "<provider>": { "type": "api_key", "key": "..." } }` for the model's provider to a 0600 temp file and renames it over `auth.json`. This replaces a link left from `host_auth`. The file is then re-checked. There is no provider-to-variable guessing: `apiKeyEnvVar` names the variable.

The variable named by `apiKeyEnvVar` is removed from the Prime child environment, so the Python kernel, bash and child processes do not inherit the key. Prime reads it from `auth.json` only.

A long-lived Claude subscription token from `claude setup-token` (prefix `sk-ant-oat`) works in this mode. It is labelled `billingType: "subscription"` with no `costUsd`. Any other key is labelled `api`.

With `allowedModels` set, the adapter also checks `auth.json` after every run: it must still be a regular 0600 file owned by the server user whose only key is the configured provider (`prime_auth_tampered`). Only key names are read into the result.

## Never

No fallback to the operator's `~/.prime/agent` as agent dir, to another provider or to another model. No key in logs, run results, session params or notes. A missing or unsafe credential fails before Prime starts: `prime_host_auth_missing`, `prime_host_auth_unsafe`, `prime_api_key_missing`, `prime_auth_file_unsafe`.

## Billing and cost

Usage tokens are reported when Prime reports them. `costUsd` is Prime's `usage.cost.total` only for `api` billing and only when > 0, else empty. Prime's cost on subscription runs (host OAuth or an `sk-ant-oat` token) is an estimate, not a charge.

## Several agents on one subscription

Observed on 2026-10-18 (prime-agent 0.10.0): two concurrent runs on one symlinked subscription succeeded; no token refresh happened during the smoke, so refresh serialization stays UNVERIFIED.

## Security

With `host_auth` every agent can read the host token through its link. Use `api_key` with a separate key per agent when that matters.
