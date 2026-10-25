# Configuration

All fields live in the agent's `adapterConfig`.

## Keys

| adapterConfig key | Type | Default | Field |
|---|---|---|---|
| `command` | string | `"prime-agent"` | `command` |
| `model` | string `provider/modelId` | required | `modelRef`, split at the **first** `/` into `provider`, `model` (`vercel-ai-gateway/openai/gpt-6.1-sol` → `vercel-ai-gateway` + `openai/gpt-6.1-sol`) |
| `thinking` | one of `PRIME_THINKING_LEVELS` | unset → `null` | `thinking` |
| `cwd` | absolute path | `null` | `cwd` |
| `instructionsFilePath` | string | `null` | `instructionsFilePath` |
| `promptTemplate` | string | `null` | `promptTemplate` |
| `bootstrapPromptTemplate` | string | `null` | `bootstrapPromptTemplate` |
| `appendSystemPrompt` | string | `null` | `appendSystemPrompt` |
| `noContextFiles` | boolean | `false` | `noContextFiles` |
| `timeoutSec` | number ≥ 0 | `0` (none) | `timeoutSec` |
| `graceSec` | number ≥ 0 | `20` | `graceSec` |
| `extraArgs` (else `args`) | string[] | `[]` | `extraArgs` |
| `env` | object | `{}` | `env` (string values only) |
| `credentialMode` | `"host_auth"` \| `"api_key"` | `"host_auth"` | `credential.mode` |
| `apiKeyEnvVar` | env var name | required when `api_key` | `credential.apiKeyEnvVar` |
| `hostAuthFile` | absolute path | `<os.homedir()>/.prime/agent/auth.json` | `credential.hostAuthFile` |
| `agentDirRoot` | absolute path | `<instanceRoot>/companies/<companyId>/agents` | §3 layout root |
| `allowedModels` | `provider/modelId` list (or one per line) | unset | [model allowlist](#model-allowlist) |
| `modelRoles` | object, role → `provider/modelId` | every role = `model` | [model allowlist](#model-allowlist); needs `allowedModels` |

Empty strings count as unset. The Paperclip UI writes the thinking level as `thinkingEffort` (create form) or `effort` (edit form). Precedence: `thinking`, then `effort`, then `thinkingEffort` (INTERFACES §16 A21). The first key that is present wins, and an empty value means Prime's own default (no `--thinking`).

## Model

The required `model` is `provider/modelId`, split at the first `/`. For example, `vercel-ai-gateway/openai/gpt-6.1-sol` means provider `vercel-ai-gateway` and model `openai/gpt-6.1-sol`. It must be listed by `prime-agent model list` for the agent's credential or the run is refused before spawn (`prime_model_unknown`). Listed is not proof of entitlement. There is no fallback to another model or provider. `--provider` and `--model` are always passed.

## Model allowlist

`allowedModels` makes the adapter own Prime's model allowlist. Unset, nothing below applies except the `settings.json` read check, and the model audit only reports.

Before every run, daemon and print:

1. The adapter reads `<agentDir>/settings.json`. Missing means `{}`. If it exists but is not a JSON object, the run fails with `prime_settings_invalid` and the file is not written (with or without `allowedModels`).
2. It refuses the config with `prime_allowed_models_invalid` if `model`, `subagentDefaultModel` or a role is not in `allowedModels`, or the list is empty.
3. It writes the managed keys and keeps every other key: `allowedModels`; `enabledModels` (= `allowedModels`); `defaultProvider` and `defaultModel` (from `model`); and the four model roles of Prime 0.10.1, `subagentDefaultModel`, `auxiliaryModel`, `providerBackupModel` and `imageModel`. A role is `modelRoles.<role>`, else `subagentDefaultModel` for that role, else `model`. A managed key changed since the last run is put back, and the run notes name it. `resultJson.settings.sha256Written` records the file after the write.

After every run, whatever the outcome (success, failure, cancel, timeout, uncertain):

- **Settings:** a managed key that differs from what was written fails the run with `prime_settings_tampered`. `resultJson.settings` has `sha256After` and `tamperedKeys`.
- **Auth (`api_key`):** `auth.json` must be a regular 0600 file whose only key is the configured provider, else `prime_auth_tampered`. See [credentials](credentials.md#api_key).
- **Model audit:** the adapter reads Prime's own session files: the parent session, every child the daemon reported (`rlm_child_update`, `list` rows with `rlmDepth > 0`, `get_session_stats`), and every `*.jsonl` under `<agentDir>/sessions/` that changed during the run. Only the lines added during this run are read. Each assistant turn's `provider/model` goes into `resultJson.modelAudit = { ok, enforced, actors: [{ sessionId, activeSessionId, depth, file, models, turns, turnsWithoutModel, tokens }], forbidden, unreadable, absent }`. The run fails with `prime_model_audit_failed` when a turn's model is outside `allowedModels`, a reported child or the parent has no readable session file (a missing file passes, listed in `absent`, only when no prompt was sent or the daemon's stats show 0 tokens for it), a turn has no `provider` or `model`, an actor's file has no turns while the daemon's stats show tokens for it, or a line is not JSON. The usage row keeps `model` only when the audit is `ok`; otherwise it shows the forbidden model, or `unverified`.

A policy failure replaces the run's own code, which moves to `errorMeta.runErrorCode`, and the session is not saved. `recentModels` is Prime's own history and is not managed. Nested settings objects (`compaction`, `branchSummary`, `autoRefine`, `retry`) are not known to hold a model in 0.10.1 (`unverified`); if one does, the audit still catches the turn after the run, but nothing blocks it during the run. Prime's project-level settings file in the working directory is not read or checked by the adapter.

## Thinking and timeouts

Levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `timeoutSec` 0 means none. The budget starts at the start of `execute`, before the Prime dir is prepared. `graceSec` 20 is the SIGTERM grace. These are the same defaults as `pi_local`.

## Working directory

Paperclip's project/issue workspace cwd wins. With the default agent-home workspace, a configured `cwd` wins. Otherwise the server's cwd is used. Execute creates a missing cwd, as `pi_local` does. The environment test only checks it (`prime_cwd_invalid`). A cwd under `~/.prime/agent`, Paperclip home entries other than `instances/<id>/workspaces` and `projects`, or the instance `secrets`, `db`, `data/backups`, `logs` dirs is refused before any mkdir (`prime_path_invalid`, INTERFACES §16 A15).

## Instructions, prompts and skills

The instructions file (`instructionsFilePath`, set by the instructions bundle) and `appendSystemPrompt` become `--append-system-prompt` arguments in that order. `promptTemplate`/`bootstrapPromptTemplate` replace Paperclip's default prompt templates. Desired Paperclip skills are linked into a temporary dir and passed as one `--skill` each for that run only. They show as `configured`, never `installed`. `noContextFiles` adds `--no-context-files`. `extraArgs` go before `-- <prompt>`.

## Per-agent Prime directory

INTERFACES §3 layout:

```
<agentDirRoot>/<agentId>/prime-agent-home/          agentDir  (PRIME_AGENT_CODING_AGENT_DIR), mode 0700
<agentDirRoot>/<agentId>/prime-agent-home/auth.json symlink to hostAuthFile, or API-key file (0600)
<agentDirRoot>/<agentId>/prime-agent-home/sessions/ sessionDir (--session-dir)
```

Prime also writes `settings.json`, `telemetry.json`, `models/`, `session-leases/`, `harness/` (per-agent memories) and `session-artifacts/` there. `agentDirRoot` moves the tree but must stay outside `~/.prime`, `~/.pi`, `~/.codex`, `~/.claude`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config` and the Paperclip secrets/DB/backup/log dirs.

Prime's Python kernel environment is `$HOME/.prime/agent/kernel-venv` of the Paperclip server user, shared by every agent and by the operator's own Prime sessions. A server with a fresh HOME sets it up on the first run (about 30 s, downloads CPython with uv). To use another kernel, set `PRIME_AGENT_KERNEL_VENV` or `PRIME_AGENT_KERNEL_PYTHON` in `env`; inherited `PRIME_AGENT_*` variables are stripped, so they must come from `env`.

## Sessions

There is one Prime session per Paperclip task session. Saved params are `sessionId`, `sessionFile`, `cwd`, `provider`, `model`, `agentDir`. A session is resumed with `-r <sessionFile>` only if all match and the file's header matches. Otherwise a fresh session starts, with one `[paperclip]` log line naming the reason: `no_saved_session`, `cwd_mismatch`, `model_mismatch`, `agent_dir_mismatch`, `session_file_missing`, `session_header_mismatch`.

Failed, cancelled, timed-out and uncertain runs never replace the saved session. Resuming restores the transcript, not Python state. Nothing is replayed after a crash (L7).

## Environment

The base is `sanitizeInheritedPaperclipEnv(process.env)` (INTERFACES §4 and §16 A17, A22). From the server environment, only these keys pass: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TZ`, `TERM`, `TMPDIR`, `XDG_*`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and their lowercase forms), `PAPERCLIP_RUNTIME_API_URL`, `PAPERCLIP_LISTEN_HOST`, `PAPERCLIP_LISTEN_PORT`. Everything else, provider keys included, is dropped. Inherited Paperclip server secrets such as `PAPERCLIP_AGENT_JWT_SECRET` never reach Prime. Stripped keys stay explicit `undefined` so the spawn helper cannot restore them. Set anything else Prime needs in config `env`.

The Paperclip run environment and config `env` are applied on top of that base, except `PRIME_AGENT_INTERNAL_*`, `RLM_*`, `PI_*` and adapter-owned keys are stripped. The adapter sets `PRIME_AGENT_CODING_AGENT_DIR=<agentDir>` and `PRIME_AGENT_TELEMETRY=0`.

Paperclip gives the agent `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_API_KEY` and, when present, `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS`.

## Concurrency

Paperclip does not serialize runs per agent by default: agents created through the API get `runtimeConfig.heartbeat.maxConcurrentRuns: 20`, and runs on different issues would share one Prime agent dir (`settings.json`, `harness/`). The adapter adds no lock. Set `runtimeConfig.heartbeat.maxConcurrentRuns: 1` on every `prime_agent_local` agent (recommended; the WP7 smoke does this). Different agents still run in parallel. (INTERFACES §16 A13.)

## Changing the model

Read the agent with `GET /api/agents/{agentId}`, change only `model`, and send the complete `adapterConfig` back with `PATCH /api/agents/{agentId}`.
