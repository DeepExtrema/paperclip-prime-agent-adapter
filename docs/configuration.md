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
| `credentialMode` | `"host_auth"` \| `"api_key"` \| `"managed_subscription"` | `"host_auth"` | `credential.mode`; `managed_subscription` needs `featureProfile: "governed-v1"` ([credentials](credentials.md#managed_subscription)) |
| `apiKeyEnvVar` | env var name | required when `api_key` | `credential.apiKeyEnvVar` |
| `hostAuthFile` | absolute path | `<os.homedir()>/.prime/agent/auth.json` | `credential.hostAuthFile` |
| `agentDirRoot` | absolute path | `<instanceRoot>/companies/<companyId>/agents` | §3 layout root |
| `allowedModels` | `provider/modelId` list (or one per line) | unset | [model allowlist](#model-allowlist) |
| `modelRoles` | object, role → `provider/modelId` | every role = `model` | [model allowlist](#model-allowlist); needs `allowedModels` |
| `featureProfile` | `"governed-v1"` | unset | [feature profile](#feature-profile-governed-v1); needs `allowedModels`, `runtime: "daemon"` and `credentialMode` `managed_subscription` or `api_key` |
| `maxSubagentsPerRun` | integer 1-8 | `2` under `governed-v1` | sessions per run other than the parent; only with `featureProfile` |

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
- **Model audit:** the adapter reads Prime's own session files: the parent session, every other session the daemon reported at any depth (`rlm_child_update`, `list` rows, including depth-0 `rlm.create_session` sessions, `get_session_stats`), and every `*.jsonl` under `<agentDir>/sessions/` that changed during the run. Only the lines added during this run are read. Each assistant turn's `provider/model` goes into `resultJson.modelAudit = { ok, enforced, actors: [{ sessionId, activeSessionId, depth, file, models, turns, turnsWithoutModel, tokens }], forbidden, unreadable, absent }`. The run fails with `prime_model_audit_failed` when a turn's model is outside `allowedModels`, a reported child or the parent has no readable session file (a missing file passes, listed in `absent`, only when no prompt was sent or the daemon's stats show 0 tokens for it), a turn has no `provider` or `model`, an actor's file has no turns while the daemon's stats show tokens for it, or a line is not JSON. The usage row keeps `model` only when the audit is `ok`; otherwise it shows the forbidden model, or `unverified`.

A policy failure replaces the run's own code, which moves to `errorMeta.runErrorCode`, and the session is not saved. `recentModels` is Prime's own history and is not managed. Nested settings objects (`compaction`, `branchSummary`, `autoRefine`, `retry`) are not known to hold a model in 0.10.1 (`unverified`); if one does, the audit still catches the turn after the run, but nothing blocks it during the run. Prime's project-level settings file in the working directory is not read or checked by the adapter.

## Thinking and timeouts

Levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `timeoutSec` 0 means none. The budget starts at the start of `execute`, before the Prime dir is prepared. `graceSec` 20 is the SIGTERM grace. These are the same defaults as `pi_local`.

**Daemon mode without `governed-v1` may run the parent with thinking off.** Prime 0.10.1 fetches its model catalog from GitHub at daemon start. A session created before that fetch lands keeps `thinkingLevel: "off"`, and the adapter's `set_thinking_level` right after `create` succeeds but changes nothing (TAI-339, offline). A `set_thinking_level` sent after the fetch makes `get_state` show the level, but the session's requests still carry no thinking, and Prime writes `defaultThinkingLevel` to `settings.json` (TAI-324, offline). Under `governed-v1` the adapter waits for the catalog, then sends `set_model` with the configured model, which puts the catalog entry on the session and restores the configured level ([item 12](#feature-profile-governed-v1)), and `defaultThinkingLevel` is a managed key, so that write changes nothing. Whether live runs without the profile hit this is `unverified`.

## Working directory

Paperclip's project/issue workspace cwd wins. With the default agent-home workspace, a configured `cwd` wins. Otherwise the server's cwd is used. Execute creates a missing cwd, as `pi_local` does. The environment test only checks it (`prime_cwd_invalid`). A cwd under `~/.prime/agent`, Paperclip home entries other than `instances/<id>/workspaces` and `projects`, or the instance `secrets`, `db`, `data/backups`, `logs` dirs is refused before any mkdir (`prime_path_invalid`, INTERFACES §16 A15).

## Instructions, prompts and skills

The instructions file (`instructionsFilePath`, set by the instructions bundle) and `appendSystemPrompt` become `--append-system-prompt` arguments in that order. `promptTemplate`/`bootstrapPromptTemplate` replace Paperclip's default prompt templates. Desired Paperclip skills are linked into a temporary dir and passed as one `--skill` each for that run only. Each is staged under the `name` in its `SKILL.md` frontmatter, because Prime requires the dir name to equal it. The runtime name is kept, with one `[paperclip]` line, when that name is missing, invalid, shared by two skills, or the name of a Prime built-in (which it would replace). They show as `configured`, never `installed`. `noContextFiles` adds `--no-context-files` in print mode. With `runtime: "daemon"` it has no effect, because Prime 0.10.1 ignores it in `create`, and the run log says so. `extraArgs` go before `-- <prompt>`.

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

Failed, cancelled, timed-out and uncertain runs never replace the saved session. Resuming restores the transcript, not Python state. In print mode nothing is replayed after a crash (L7). In daemon mode, Prime 0.10.1 resends a crashed turn's prompt at `create` from the dead worker's recovery journal; `governed-v1` stops this (the last bullet).

- **A missing or unknown session file** starts one fresh session, with the log line `[paperclip] Prime session <id> is unavailable (<reason>); starting a fresh session.` The run returns the new session without `clearSession`, so the host replaces the row. Print mode does the same.
- **A held session lease** (the session is open in another Prime process) fails the run with `prime_session_busy`, with no session fields and no `clearSession`, so the row is kept. With one daemon per run, this means a process from an earlier run is still alive.
- **A policy failure** (`prime_model_audit_failed`, `prime_settings_tampered`, `prime_auth_tampered`) with `allowedModels` set returns `clearSession: true`, so a session that holds forbidden turns is not resumed. A `prime_settings_tampered` that comes only from the shared workspace file is the exception: it returns no `clearSession`.
- **Auth and quota failures** (`prime_provider_auth_failed`, `prime_provider_quota`) keep the session.
- **A turn a crash left interrupted** (`governed-v1` only, plan G3 item 6). At run start, after item 13's leftover check and the shell reap, the adapter reads each `<agentDir>/daemon-workers/**/*.recovery.jsonl`. A journal whose newest record is `busy: true` gives the warning `Prime session <id> was interrupted mid-turn (<operation>); dropping the recovery journal.` and `featureProfile.interruptedSession = { sessionId, operation }`. Then `daemon-workers/` is deleted whole, and the session resumes as usual with its finished turns; only the crashed turn's prompt is dropped. As a backstop, item 12's `get_state` must show `isStreaming: false` and a `messageCount` no higher than the `message` entries in the session file before `create`. Otherwise the adapter kills that session, starts a fresh one with item 10's check and item 12's steps, and sets `interruptedSession = { sessionId, detectedVia }` with a warning. Once the backstop has fired, no failure in that run returns `executionRecovery` with `providerWorkStarted: false`. Without `governed-v1`, `daemon-workers/` is left alone.

## Persistent shells

**Persistent shells end when the run ends.** A shell from Prime's `bash(..., persistent=True)` leads its own process session, so stopping the daemon and its workers does not reach it. Prime records each one in `<agentDir>/persistent-shells/<id>.json`. After the Prime process is gone, and before any run-end check, the adapter ends each recorded shell whose pid still has the recorded start id: `SIGKILL` to its process group and to every process in its session, re-checked every 100 ms for up to 2 s. Each one gets an `[paperclip] ended persistent shell <id> (pid N, session <sessionId>)` line, or a warning if it did not stop.

- Under `governed-v1`: every recorded shell, at run end and also at run start (for shells left by a crash). Item 13's sweep then ends what the records miss.
- Without it: only shells of the sessions this run used, at run end only.
- If `persistent-shells` is a symlink or not a dir, no record is read, and the log says `persistent-shells is not a dir; not read`.
- Not covered by the records: a process that leaves the shell's session (`setsid`), a double fork, or a shell whose record the agent deleted. Under `governed-v1` the sweep ends these while they carry the agent's marker.

## Environment

The base is `sanitizeInheritedPaperclipEnv(process.env)` (INTERFACES §4 and §16 A17, A22). From the server environment, only these keys pass: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TZ`, `TERM`, `TMPDIR`, `XDG_*`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and their lowercase forms), `PAPERCLIP_RUNTIME_API_URL`, `PAPERCLIP_LISTEN_HOST`, `PAPERCLIP_LISTEN_PORT`. Everything else, provider keys included, is dropped. Inherited Paperclip server secrets such as `PAPERCLIP_AGENT_JWT_SECRET` never reach Prime. Stripped keys stay explicit `undefined` so the spawn helper cannot restore them. Set anything else Prime needs in config `env`.

The Paperclip run environment and config `env` are applied on top of that base, except `PRIME_AGENT_INTERNAL_*`, `RLM_*`, `PI_*` and adapter-owned keys are stripped. The adapter sets `PRIME_AGENT_CODING_AGENT_DIR=<agentDir>` and `PRIME_AGENT_TELEMETRY=0`.

Paperclip gives the agent `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_API_KEY` and, when present, `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS`.

## Concurrency

Paperclip does not serialize runs per agent by default: agents created through the API get `runtimeConfig.heartbeat.maxConcurrentRuns: 20`, and runs on different issues would share one Prime agent dir (`settings.json`, `harness/`). The adapter adds no lock. Set `runtimeConfig.heartbeat.maxConcurrentRuns: 1` on every `prime_agent_local` agent (recommended; the WP7 smoke does this). Different agents still run in parallel. (INTERFACES §16 A13.) **Under `governed-v1`, one run per agent at a time, and every process that the run leaves ends at run end** ([item 13](#feature-profile-governed-v1)). A second run that overlaps fails with `prime_concurrent_run`, whatever `maxConcurrentRuns` says, so still set it to 1. A governed agent cannot keep a process, such as a dev server, running between runs.

## Feature profile governed-v1

`featureProfile: "governed-v1"` is one closed value, not a set of switches. It needs `allowedModels`, `runtime: "daemon"`, `thinking`, a level that every allowed model supports (for Opus 5.5: `low`, `medium`, `high`, `xhigh` or `max`; item 12), and `credentialMode` `managed_subscription` or `api_key`, never `host_auth`. Otherwise the run fails with `prime_feature_profile_invalid` before any file is written. `maxSubagentsPerRun` (1-8, default 2) is allowed only with it. Every move below goes to `<agentDir>/.paperclip-disabled/<runId>/`, and no move or write follows a symlink.

The numbers are the items of TAI-273 plan section 2.2.

1. **Managed settings keys**, written before each run and checked after it like the model keys: `harnessRefinements: true`, `autoRefine: {enabled: false}`, `factory: {enabled: false}`, `rlmMaxDepth` (default 1), `retry: {provider: {waitForUsage: {enabled: false, pauseUntilReset: false}}}`, `agentTraces: {enabled: false}`, `telemetry: {enabled: false}`, `skills: ["!**"]`, `enableBuiltinSkills: false` and `defaultThinkingLevel` (the value of `thinking`). The child env also gets `DO_NOT_TRACK=1`. A session with `isQuotaParked: true` fails the run with `prime_provider_quota`. Whether `autoRefine` and `waitForUsage` act in 0.10.1 is `unverified`.
2. **Sessions per run.** Every Prime session other than the parent counts, at any depth, keyed by `sessionId`. One over `maxSubagentsPerRun` is ended (`cancel_rlm_child` then `delete_rlm_subagent` at depth 1 and below, `kill` at depth 0). An end that fails, or an ended session seen running again, fails the run with `prime_subagent_limit_exceeded`.
3. **The run report**, `resultJson.featureProfile`: `profile`, `maxSubagentsPerRun`, `sessions`, `sessionsEnded` (`{ sessionId, depth, reason, skills? }`), `skillDiscovery`, `sessionSkillChecks`, `agentSkills`, `agentSkillsDisabled`, `agentDirDisabled`, `contextFilesDisabled`, `contextFilesCreated`, `projectConfigDisabled`, `projectConfigCreated`, `workspaceContextFiles`, `settingsKeysRemoved`, `foreignGoals`, `scheduledJobsDisabled`, `scheduledJobsCreated`, `harnessEntriesDisabled`, `harnessBytes`, `harnessFingerprint`, `refinementEvents`, `cachesCleared`, `modelCatalog`, `persistentShellsKilled`, `processesSwept`, `interruptedSession` (only when set) and `warnings`. Each warning is also one `[paperclip] warning:` line in the run log.
4. **Saved Prime schedules** (`session-artifacts/*/scheduled-jobs.json`) are renamed at run start.
5. **`settings.json` is an allowlist:** the managed keys and `onboardingShown`, `onboardingCompleted`, `recentModels`, `quietStartup` and `theme`. Other keys are removed at run start and run end and reported by name. A run that adds a key that runs commands, loads code, prompts or skills, or changes the model, retries or sessions (`shellPath`, `mcpServers`, `packages`, `extensions`, `compaction` and the rest of the list in `src/server/feature-profile.ts`) fails with `prime_settings_tampered`. Prime itself writes `recentModels`, and `defaultProvider` and `defaultModel` with the managed values, in every run (item 12's `set_model`).
6. **Context files and the workspace's Prime config.** `<agentDir>/AGENTS.md`, `SYSTEM.md` and `APPEND_SYSTEM.md` move aside. Every entry of `<cwd>/.prime/agent/` moves to `<cwd>/.prime/agent.disabled-<runId>/`, except the workspace file of item 10. `AGENTS.md` and `CLAUDE.md` in `cwd` and every parent dir are not moved: Prime loads them from every ancestor up to `/`. They are hashed before and after the run. A file in `cwd` gives a warning when it changes, and a file above `cwd` gives a warning on every run.
7. **Goals not set by Paperclip** are cleared with `/goal clear` before the first prompt. If that fails, the session is killed and a fresh one is returned without `clearSession`.
8. **The global harness keeps only memory.** Non-memory entries of `<agentDir>/harness/harness_state.json` are removed, and both refine stores move aside.
9. **Agent-installed skills**: every entry under `<agentDir>/skills/` moves aside.
10. **The skill list.** The parent gets only the staged Paperclip skills and six Prime built-ins by path (`agent-message`, `agent-observe`, `attach-image`, `compact`, `edit`, `refine`, plus `goal` when `goal` is set). The adapter keeps one file in the workspace, `<cwd>/.prime/agent/settings.json`, holding exactly `{"skills":["!**"]}`. It stays between runs, because agents can share a `cwd`, and the adapter never deletes it. Before the first prompt, Prime's own skill list for the parent must match exactly, or the run fails with `prime_skill_list_invalid`. Every other session is checked the first time the adapter sees it, and one that loaded a skill off the list is ended with a warning, while the run goes on. If the workspace file is missing or changed at run end, the adapter restores it and the run fails with `prime_settings_tampered`, with no `clearSession`.
11. **The agent dir is an allowlist.** Top-level entries other than `settings.json`, `auth.json`, `sessions/`, `session-artifacts/`, `harness/`, `skills/`, `refinement_history.jsonl`, `telemetry.json`, `.paperclip-disabled/`, `session-leases/`, `rlm-ledger/` and `logs/` move aside with a warning, `models.json` included, because it can send the token to another host. The catalog caches `models/` and `mcp-service-catalog.v2.json` are deleted and listed in `cachesCleared`, with no warning. `daemon-workers/` is deleted too, before this step (G3 item 6, under "Sessions").
12. **The model catalog.** After `create`, Prime's catalog (`get_model_catalog`) is read every 500 ms for up to 15 s. Each `allowedModels` entry must be listed, an `anthropic` one must have `baseUrl` `https://api.anthropic.com`, and each must have `reasoning: true`, whatever `thinking` is. The wait ends when they do. Then `thinking` must be a level that every allowed model supports, by Prime's rule: a level its `thinkingLevelMap` maps to `null` is not supported, `xhigh` and `max` need a non-null value, and `off`, `minimal`, `low`, `medium` and `high` are supported when the key or the whole map is absent. For Opus 5.5 that is `low`, `medium`, `high`, `xhigh` or `max`, so `off` and `minimal` fail every run. An address or level failure ends the wait at once, and no `set_model` is sent; the log line is `[paperclip] Prime model catalog check failed: thinking level <level> is not supported by <provider>/<id>; supported: <levels>`. Then `set_model` is sent with the configured model, even when `create` already shows it. Its answer must have the configured `provider` and `id` and pass the same checks (`reasoning: true` at every level, `off` included), and is recorded in `modelCatalog.liveModel`. Then `get_state` must report the configured level. The adapter's one `set_thinking_level` (sent only when `create` shows another level) waits until the catalog check passes, then goes before `set_model`, so Prime is never asked for a level it would clamp and save. No second one is sent after `set_model`: it would change `get_state` but not the request. A fresh session from item 7 gets the same step. A managed key that changed during the run fails it with `prime_settings_tampered` and `clearSession: true`, also when the catalog check failed first; that failure's log line stays, and the result has no `executionRecovery`. The catalog is checked again after each `model_catalog_changed` during the run. A failure is `prime_model_catalog_invalid`, with no `clearSession`.
13. **One run per agent dir, and no process outlives the run.** The marker is `PRIME_AGENT_CODING_AGENT_DIR=<agentDir>`, which every daemon, worker, kernel and shell process of the run carries.
    - A second governed run for an agent dir that has one in progress fails with `prime_concurrent_run`, before any write. The set of running dirs is shared by every copy of the adapter module in the server.
    - At run start, a live process that carries the marker fails the run with `prime_leftover_processes`, before any write. The message lists each process and ends with a `kill -9` line.
    - At run end, after the shell reap and before every run-end check, every process that still carries the marker gets `SIGKILL` and is listed in `processesSwept` and `warnings`. This ends `setsid` and `tmux` jobs, double forks, and shells whose record was deleted.
    - Not covered: a process that drops or changes the marker (`env -i`, a changed `PRIME_AGENT_CODING_AGENT_DIR`) outside a recorded shell's session.

## Changing the model

Read the agent with `GET /api/agents/{agentId}`, change only `model`, and send the complete `adapterConfig` back with `PATCH /api/agents/{agentId}`.
