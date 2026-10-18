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
| `prime_model_listed` | check (info) | The configured model is listed. Listed is not proof of entitlement; only a run proves that. | Nothing. |
| `prime_model_unknown` | check (error) / thrown | The configured model is not in the list for this credential. The run is refused before spawn. | Pick an id from the list shown in the message. |
| `prime_preflight_failed` | run result | A step before spawn failed (config, credential, version, model, skills). The saved session is kept. | Read `errorMeta.primeErrorCode` and fix that code. |
| `prime_run_failed` | run result | Prime exited non-zero or the provider returned an error (`stopReason: "error"`). | Read `errorMessage`; check the provider login and the model. |
| `prime_run_uncertain` | run result | Prime ended without an `agent_end` event (killed, crashed, lost). The outcome is unknown and the session is kept. | Read the issue and its comments before any retry; do not repeat a mutation blindly. |
| `prime_run_timeout` | run result | `timeoutSec` was reached (the budget starts before seeding). | Raise `timeoutSec` or split the work. |
| `prime_run_cancelled` | run result | The run was cancelled; Prime was never spawned after the cancel. | Nothing. |
| `prime_credential_mode_invalid` | thrown | `credentialMode` is not `host_auth` or `api_key`. | Fix `credentialMode`. |
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

**Empty model list in the UI:** the list uses `~/.prime/agent/auth.json` of the Paperclip server user. Agents with `api_key` are checked by the environment test and at run time, not here. `listModels()` runs without agent context, so it resolves the default `prime-agent` on the server's PATH and ignores the agent's `command`. The attempt-1 smoke failed because that PATH omitted `~/.local/bin`; the adapter now falls back to `~/.local/bin/prime-agent`.

If the list is still empty, either `prime-agent` is neither on the server's PATH nor at `~/.local/bin/prime-agent` of the server user, or `prime-agent model list` failed for the host login (the failure is not logged). Run `prime-agent model list` as the server user to see why. The agent's `command` does not affect this list; runs and the environment test use it.

**First run is slow:** Prime sets up its Python kernel once per server HOME (`› setting up python kernel (one-time, ~30s)…` on stderr).

**`[paperclip]` line says the session was not resumed:** the reason names the field that changed. See [configuration](configuration.md).

**A resume file is missing:** Prime 0.10.0 does not fail on `-r <missing path>`; it silently starts a new session at that path. The adapter therefore passes `-r` only after reading a matching session header.

**401 `OAuth access token has expired` in a long run:** the next run reads the refreshed token through the link; rerun the task.

**Processes left after a run:** list processes whose environment has `PRIME_AGENT_CODING_AGENT_DIR=<agent dir>`. None should remain after a run ends.
