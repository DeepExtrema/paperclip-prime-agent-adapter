# Troubleshooting

First run the environment test: `POST /api/companies/{companyId}/adapters/prime_agent_local/test-environment` with `{"adapterConfig": {...}}`, or the UI "Test environment" button. It makes no model call.

## Codes

| Code | Kind | Meaning | Fix |
|---|---|---|---|
| `prime_cwd_valid` | check (info) | The working directory exists. | Nothing. |
| `prime_cwd_invalid` | check (error) | `cwd` (or the server's cwd) is missing, not a directory, or a protected path (§16 A16). The environment test never creates it; a run creates it. | Create the directory or choose an allowed `cwd`. |
| `prime_cli_found` | check (info) | `command` was found. | Nothing. |
| `prime_cli_missing` | check (error) / thrown | `prime-agent` (or `command`) cannot be spawned by the Paperclip server user. | Install prime-agent 0.10.x or set `command` to its absolute path. |
| `prime_cli_version` | check (info) | `prime-agent --version` was read. | Nothing. |
| `prime_cli_version_unsupported` | check (error) / thrown | Version outside `>= 0.10.0, < 0.11.0`. | Install a 0.10.x release. |
| `prime_cli_version_unreadable` | check (error) / thrown | `--version` failed or did not print `x.y.z`. | Run `prime-agent --version` as the server user and fix the install. |
| `prime_config_invalid` | check (error) | Config cannot be resolved, or a remote execution target was selected (phase 1 is local only). | Fix the field named in the message; use a local target. |
| `prime_model_required` | check (error) / thrown | `model` is missing or empty. | Set `model` to `provider/modelId`. |
| `prime_model_invalid` | check (error) / thrown | `model` has no `/`, or an empty provider or model part. | Use the `provider/modelId` form from `prime-agent model list`. |
| `prime_thinking_invalid` | check (error) / thrown | `thinking` is not one of the levels. | Use off, minimal, low, medium, high, xhigh or max. |
| `prime_auth_host_linked` | check (info) | The host auth file is present and safe; shows the billing class only. | Nothing. |
| `prime_auth_api_key` | check (info) | The `apiKeyEnvVar` variable is set (value never shown). | Nothing. |
| `prime_auth_missing` | check (error) | No usable credential (host file missing, or the API-key variable empty). | See [credentials](credentials.md). |
| `prime_auth_unsafe` | check (error) | The credential file is not a regular file owned by the server user with mode 0600. | `chmod 600` the file and fix its owner. |
| `prime_models_discovered` | check (info) | `prime-agent model list` returned models. | Nothing. |
| `prime_models_empty` | check (warn) | The credential reaches no models. | Log in to a provider with Prime or use another credential. |
| `prime_models_discovery_failed` | check (warn) | `prime-agent model list` failed. | Run it as the server user and read the first output line. |
| `prime_models_skipped` | check (info) | `host_auth`: the environment test checks the host login file in place and lists no models, because the login is never linked into a temp dir. `managed_subscription`: the token is written to the agent dir only during a run. The first run checks the model. | Nothing; or use `api_key`. |
| `prime_auth_managed_registered` | check (info) | `managed_subscription`: at load, the adapter added `prime_agent_local` to the host's Anthropic subscription connection list. | Nothing. |
| `prime_auth_managed_unregistered` | check (error) | `managed_subscription`: the registration did not take, so the host refuses the connection for this adapter. The message says why. | Link `@paperclipai/shared` from the running Paperclip install (`node scripts/link-adapter-utils.mjs`) and restart the server. |
| `prime_auth_managed_token_ok` | check (info) | `managed_subscription`: the token in the test body is a Claude subscription token and matches the connection identity. It does not show that Anthropic accepts it; only a run does. | Nothing. |
| `prime_model_listed` | check (info) | The configured model is listed. Listed is not proof of entitlement; only a run proves that. | Nothing. |
| `prime_model_unknown` | check (error) / thrown | The configured model is not in the list for this credential. The run is refused before spawn. | Pick an id from the list shown in the message. |
| `prime_preflight_failed` | run result | A step before spawn failed (config, credential, version, model, skills). The saved session is kept. | Read `errorMeta.primeErrorCode` and fix that code. |
| `prime_run_failed` | run result | Prime exited non-zero or the provider returned an error (`stopReason: "error"`). | Read `errorMessage`; check the provider login and the model. |
| `prime_run_uncertain` | run result | Prime ended without an `agent_end` event (killed, crashed, lost). The outcome is unknown and the session is kept. | Read the issue and its comments before any retry; do not repeat a mutation blindly. |
| `prime_run_timeout` | run result | `timeoutSec` was reached (the budget starts before seeding). | Raise `timeoutSec` or split the work. |
| `prime_run_cancelled` | run result | The run was cancelled; Prime was never spawned after the cancel. | Nothing. |
| `prime_settings_invalid` | run result | `<agentDir>/settings.json` exists but is not a JSON object, or cannot be read. Prime was not started and the file was not written. Applies with or without `allowedModels`. | Fix or remove the file. |
| `prime_allowed_models_invalid` | run result | `allowedModels` or `modelRoles` is malformed, or `model`, `subagentDefaultModel` or a role is not in `allowedModels`. Prime was not started. | Fix the config; the message names the keys. |
| `prime_settings_tampered` | run result | `allowedModels` set: a managed `settings.json` key differs after the run from what the adapter wrote. `resultJson.settings.tamperedKeys` names them. The run's own code is in `errorMeta.runErrorCode`. | Read the run log for who changed it. The next run writes the keys again. |
| `prime_auth_tampered` | run result | `allowedModels` set, `api_key` or `managed_subscription` mode: after the run `auth.json` is not a regular 0600 file whose only key is the configured provider. `resultJson.authCheck` has the key names (never values). | Find what wrote it. The next run replaces the file. |
| `prime_managed_connection_invalid` | check (error) / run result | The agent has a Paperclip AI connection but `credentialMode` is not `managed_subscription`; or `managed_subscription` lacks `featureProfile: "governed-v1"`, the host's Anthropic subscription connection, a matching `sk-ant-oat` token, an `anthropic/…` model or `allowedModels`. Nothing was written and Prime did not start. | Fix the config named in the message, or remove the connection. |
| `prime_auth_cleanup_failed` | run result | `managed_subscription`: `<agentDir>/auth.json` could not be deleted after the run, so the subscription token is still on disk. The log names the path; the run's own code is in `errorMeta.runErrorCode`. | Delete the path by hand and find what replaced the file. |
| `prime_provider_auth_failed` | run result | The provider refused the credential (401 or 403; Prime's diagnostic kind `auth`). The session row is kept, so the next run resumes. Under `managed_subscription` this is usually a token copy that expired during a long run. | Nothing for an expired copy: the next run takes a new token. Otherwise check the login. |
| `prime_provider_quota` | run result | The provider's rate or usage limit, after Prime's own retries (diagnostic kind `rate_limit`). The session row is kept. | Wait for the limit to reset; Paperclip's retry decides when to try again. |
| `prime_model_audit_failed` | run result | `allowedModels` set: an actor ran a model outside the list, or an actor's model could not be read (no session file, a turn without `provider` or `model`, tokens but no turns, an unparseable line). `resultJson.modelAudit` names each actor. The usage row's model is the forbidden model, or `unverified`. | Treat as a policy breach until the audit shows otherwise. |
| `prime_feature_profile_invalid` | run result | `featureProfile` is not `"governed-v1"`, or `governed-v1` lacks `allowedModels`, `runtime: "daemon"`, `thinking` or `credentialMode` `managed_subscription` / `api_key`; or `maxSubagentsPerRun` is set without the profile or is not 1-8. Nothing was written and Prime did not start. | Fix the config named in the message. |
| `prime_subagent_limit_exceeded` | run result | `governed-v1`: a session over `maxSubagentsPerRun` could not be ended, or a session the adapter ended was seen running again (a woken session). The log names the session id. | Read the run log; a prompt that keeps spawning sessions needs a higher cap or less fan-out. |
| `prime_session_busy` | run result | The saved Prime session is open in another Prime process (a held session lease), so Prime was not started. With one daemon per run, a process from an earlier run is still alive. The session row is kept. | Find and stop the holder (the log names its pid when Prime gives one); do not start a fresh session around it. |
| `prime_skill_list_invalid` | run result | `governed-v1`: before any prompt, the parent's skill list (Prime's own snapshot) held a skill that is not a staged Paperclip skill or an allowlisted built-in, missed one of those, was empty, or could not be read; or a session the adapter ended for its skills could not be ended or ran again. A session other than the parent that loads such a skill is only ended, with a warning. | Read the log line; look for a `.prime/agent/` or `.agents/skills/` dir that a session found, or a Prime release that changed its skill dirs. |
| `prime_model_catalog_invalid` | run result | `governed-v1`: in Prime's model catalog (`get_model_catalog`), an `allowedModels` entry is not listed, an `anthropic` one has a `baseUrl` other than `https://api.anthropic.com`, or one has no `reasoning` while `thinking` is set and not `off`; or, after `set_model` with the configured model, it fails, its answer names another model or fails the same checks, or the parent's `thinkingLevel` is not the configured one. Before the first prompt the catalog is read every 500 ms for up to 15 s; during the run it is read after each `model_catalog_changed`. No `clearSession`. | Read the `[paperclip] Prime model catalog check failed:` line. A catalog that never lists the model with reasoning means the GitHub catalog fetch did not land; a changed `baseUrl` means the upstream catalog changed. `thinking` must be a level the model supports. |
| `prime_concurrent_run` | run result | `governed-v1`: another run of this agent (the same agent dir) is in progress in this server, so nothing was written, moved or signalled. Usually `runtimeConfig.heartbeat.maxConcurrentRuns` is missing or above 1 (the host then uses 20). No session fields, no `clearSession`. | Argus: set `maxConcurrentRuns` to 1. |
| `prime_leftover_processes` | run result | `governed-v1`: at run start, a live process carries this agent's `PRIME_AGENT_CODING_AGENT_DIR`, so an earlier run's daemon, worker, kernel or shell outlived it (usually a crash). Nothing was written. The message lists each pid, session id and command, and ends with a `kill -9` line. No session fields, no `clearSession`. | Relay: check the processes, then run the `kill -9` line. The next run then starts. |
| `prime_credential_mode_invalid` | thrown | `credentialMode` is not `host_auth`, `api_key` or `managed_subscription`. | Fix `credentialMode`. |
| `prime_api_key_env_var_required` | thrown | `credentialMode: "api_key"` without `apiKeyEnvVar`. | Set `apiKeyEnvVar`. |
| `prime_path_invalid` | thrown | `cwd`, `hostAuthFile` or `agentDirRoot` is not absolute, or `cwd` is a protected path (§16 A15). | Use absolute paths and an allowed `cwd`. |
| `prime_host_auth_missing` | check (error) / thrown | The host auth file is missing or a dangling link. | Log in with `prime-agent` as the server user, or fix `hostAuthFile`. |
| `prime_host_auth_unsafe` | check (error) / thrown | The host auth file is not a regular file owned by the server user with mode 0600. | `chmod 600 ~/.prime/agent/auth.json`. |
| `prime_api_key_missing` | check (error) / thrown | The variable named by `apiKeyEnvVar` is empty in the run env. | Bind the variable to a Paperclip secret in `env`. |
| `prime_auth_file_unsafe` | check (error) / thrown | The written per-agent `auth.json` failed its re-check. | Check the agent dir owner and mode; remove a foreign file. |
| `prime_agent_dir_unsafe` | check (error) / thrown | The agent dir is a symlink, has another owner, or overlaps `~/.prime`, `~/.pi`, `~/.codex`, `~/.claude`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config` or Paperclip secrets/DB/backup/log dirs. | Move `agentDirRoot` under the Paperclip company tree (the default). |
| `prime_model_list_failed` | thrown | `prime-agent model list` exited non-zero or timed out (20 s). | Run it as the server user with the same agent dir. |

## Other symptoms

**Adapter missing after a restart:** `GET /api/adapters/prime_agent_local` returns 404. `dist/index.js` is missing or the import failed. The server log has `Failed to dynamically load external adapter; skipping`. Run `npm run build` and reload.

**Model list in the UI:** `listModels()` runs `prime-agent model list` in a temp dir holding a placeholder Anthropic key, so it shows the Anthropic rows of Prime's catalog (16 rows on 0.10.1, including `anthropic/claude-opus-5-5`). It never links or reads the host login. Other providers' models are not offered there; type them into `model`. Each agent's own credential is checked by the environment test (`api_key`) and at run time. `listModels()` runs without agent context, so it resolves the default `prime-agent` on the server's PATH and ignores the agent's `command`. The attempt-1 smoke failed because that PATH omitted `~/.local/bin`; the adapter now falls back to `~/.local/bin/prime-agent`.

If the list is still empty, either `prime-agent` is neither on the server's PATH nor at `~/.local/bin/prime-agent` of the server user, or `prime-agent model list` failed (the failure is not logged). Run `prime-agent model list` as the server user to see why. The agent's `command` does not affect this list; runs and the environment test use it.

**First run is slow:** Prime sets up its Python kernel once per server HOME (`› setting up python kernel (one-time, ~30s)…` on stderr).

**`[paperclip]` line says the session was not resumed:** the reason names the field that changed. See [configuration](configuration.md).

**A resume file is missing:** Prime 0.10.0 does not fail on `-r <missing path>`; it silently starts a new session at that path. The adapter therefore passes `-r` only after reading a matching session header.

**401 `OAuth access token has expired` in a long run (`host_auth`):** Prime 0.10 refreshes by writing a new `auth.json` over the link, so the agent dir then holds its own copy and the host login is split. See [credentials](credentials.md#host_auth-unsafe-with-prime-010). Use `api_key`.

**Processes left after a run:** list processes whose environment has `PRIME_AGENT_CODING_AGENT_DIR=<agent dir>`. None should remain after a run ends.
