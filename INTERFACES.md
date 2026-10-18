# prime_agent_local: frozen interfaces (WP0)

Status: frozen on `main` by WP0. Workers code against `src/types.ts`, `src/errors.ts` and this file. Workers do not edit either file. If a contract is wrong or missing, write the problem in `NOTES.md` in your worktree and stop; the parent decides and amends this file on `main`.

Binding inputs: `MASTER-PLAN.md` (including "Decisions after the salvage audit"), `SALVAGE-AUDIT.md` §2-§4 and lessons L1-L17, Paperclip `docs/adapters/{external-adapters,creating-an-adapter,adapter-ui-parser}.md`, and the host `@paperclipai/adapter-utils` 0.3.1 types (`node_modules/@paperclipai/adapter-utils/dist/types.d.ts`).

Marked `UNVERIFIED:` = not checked against prime-agent 0.10.0 or the host. A worker who verifies or disproves one reports it; nobody guesses around it silently.

## 0. Ownership

| File | Owner | Notes |
|---|---|---|
| `package.json`, `package-lock.json`, `.npmrc`, `tsconfig*.json`, `vitest.config.ts`, `scripts/link-adapter-utils.mjs` | WP0 | Frozen. Dependency changes go through the parent. |
| `src/types.ts`, `src/errors.ts`, `INTERFACES.md` | WP0 | Frozen contracts. |
| `src/index.ts`, `src/server/index.ts` | WP0 | Frozen wiring. Workers fill the modules they import. |
| `src/server/runtime-config.ts` | WP1 | §2, §3, §4 |
| `src/server/parse.ts` | WP2 | §6 |
| `src/server/execute.ts` | WP3 | §5, §11 |
| `src/server/session.ts`, `src/server/models.ts`, `src/server/skills.ts` | WP4 | §7, §8, §9 |
| `src/server/version.ts`, `src/server/test.ts` | WP5 | §8, §10 |
| `src/ui-parser.ts`, `src/ui/*`, `src/cli/*`, `src/server/config-schema.ts` | WP6 | §12 |
| `test/fixtures/**` | WP0 creates; WP2 may add new files | The captured `prime-jsonl/run1-4` files are never edited (`test/contract.test.ts` pins their sha256). |
| `test/<module>.test.ts` | owner of the module | Tests live in `test/`, not `src/` (keeps them out of `dist`). |

Every stub keeps its exported name and its `satisfies`-equivalent type annotation (`export const x: ContractType = ...`). Replace the body; do not change the annotation.

Commands (run from the repo root with Node 24.18): `npm install`, `npx tsc --noEmit` (src), `npx tsc -p tsconfig.test.json` (src + test), `npx vitest run`.

## 1. Package and server module (WP0, frozen)

- Type key `prime_agent_local` (`PRIME_ADAPTER_TYPE`), label `Prime Agent`. `prime_local` is taken by a third-party adapter.
- Package `@deepextrema/paperclip-prime-local-adapter`, ESM, exports `.`, `./server`, `./ui-parser`, `./ui`, `./cli`; `paperclip.adapterUiParser = "1.0.0"`; engines `node >=24.11.0`.
- `@paperclipai/adapter-utils` is a peer dependency (`0.3.1`) and is symlinked from the host Paperclip install by `scripts/link-adapter-utils.mjs` (postinstall). See WP0-REPORT for why `file:` does not work.
- `createServerAdapter()` (in `src/server/index.ts`, re-exported from `src/index.ts`) returns:

| Field | Value | Source |
|---|---|---|
| `type` | `"prime_agent_local"` | §1 |
| `execute` | `execute` | WP3 |
| `testEnvironment` | `testEnvironment` | WP5 |
| `listSkills` / `syncSkills` | `listPrimeSkills` / `syncPrimeSkills` | WP4 |
| `sessionCodec` | `primeSessionCodec` | WP4 |
| `models` | `[]` | static; real list from `listModels` |
| `listModels` / `refreshModels` | `listPrimeModelsForAdapter` / `refreshPrimeModelsForAdapter` | WP4 |
| `detectModel` | `detectPrimeModelForAdapter` | WP4 |
| `getConfigSchema` | `getPrimeConfigSchema` | WP6 |
| `agentConfigurationDoc` | string in `src/index.ts` | WP0 (WP7 may propose edits) |
| `runtimeToolDelivery` | `"environment"` | as pi-local |
| `supportsLocalAgentJwt` | `true` | agent needs `PAPERCLIP_API_KEY` (salvage §2.1, inverted from prime_bff) |
| `supportsInstructionsBundle` / `instructionsPathKey` | `true` / `"instructionsFilePath"` | as pi-local |
| `requiresMaterializedRuntimeSkills` | `true` | as pi-local: skills are symlinked from their on-disk source |

Not set (phase 1): `sessionManagement`, `getRuntimeCommandSpec`, `loginCapability`, `getQuotaWindows`, `onHireApproved`, `acp`. Remote/sandbox execution targets are out of scope: `execute` and `testEnvironment` refuse a non-local `executionTarget` (§10, §11).

## 2. Runtime config: `resolvePrimeRuntimeConfig` (WP1, `src/server/runtime-config.ts`)

```ts
resolvePrimeRuntimeConfig(config: Record<string, unknown>, agent: { id: string; companyId: string }, instanceRoot: string): PrimeRuntimeConfig
```

Behaviour. Pure and synchronous: reads `adapterConfig`, applies defaults, validates, and returns `PrimeRuntimeConfig` (see `src/types.ts`) including the agent dir plan (§3). It does not touch the filesystem. `instanceRoot` is `resolvePaperclipInstanceRootForAdapter()` from `@paperclipai/adapter-utils/server-utils` (`<PAPERCLIP_HOME>/instances/<instanceId>`). The result holds no secret values (`env` holds whatever config.env holds; callers must not log it).

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

Defaults for `timeoutSec`, `graceSec` and thinking follow pi-local (L12). Empty strings count as unset.

Errors (`PrimeConfigError`, `src/errors.ts`): `prime_model_required` (missing/empty model), `prime_model_invalid` (no `/`, empty provider or model part), `prime_thinking_invalid`, `prime_credential_mode_invalid`, `prime_api_key_env_var_required` (`api_key` without `apiKeyEnvVar`), `prime_path_invalid` (`cwd`, `hostAuthFile` or `agentDirRoot` not absolute). No silent fallback to another model or provider.

## 3. Agent dir: plan, seeding, ephemeral dirs (WP1)

Layout (`PrimeAgentDirPlan`, kind `"agent"`):

```
<agentDirRoot>/<agentId>/prime-agent-home/          agentDir  (PRIME_AGENT_CODING_AGENT_DIR), mode 0700
<agentDirRoot>/<agentId>/prime-agent-home/auth.json symlink to hostAuthFile, or API-key file (0600)
<agentDirRoot>/<agentId>/prime-agent-home/sessions/ sessionDir (--session-dir)
```

Prime itself writes `settings.json`, `telemetry.json`, `models/provider-model-catalog.v1.json` and `session-leases/` into the agent dir (observed). Its harness writes per-agent global memory under `<agentDir>/harness/` (salvage F4). UNVERIFIED: where `session-artifacts/` goes; in the check runs it appeared next to `--session-dir` (`<parent of sessions>/session-artifacts`), which here is inside `prime-agent-home`.

```ts
seedPrimeAgentDir(plan, { provider, env }): Promise<SeededPrimeAgentDir>
createEphemeralPrimeAgentDir(credential): Promise<{ plan; cleanup }>
```

`seedPrimeAgentDir` behaviour, in order (L3, L6, R-27):
1. Path safety for `agentDir` (L6): absolute; no overlap in either direction with `~/.prime`, `~/.pi`, `~/.codex`, `~/.claude`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config`, the Paperclip `secrets/` dir and DB/backup/log dirs (reduced salvage §2.4 list). Create parents with `mkdir -p`, the agent dir and `sessions/` with mode `0700`. If the agent dir already exists it must be a real directory (not a symlink) owned by this uid; re-assert mode `0700`. Error: `PrimeCredentialError("prime_agent_dir_unsafe")`.
2. `host_auth`: `hostAuthFile` must exist (follow links), be a regular file owned by this uid with `mode & 0o077 === 0`. Then make `<agentDir>/auth.json` a symlink to `hostAuthFile` (absolute target), re-asserted every run: replace a stale regular file, a wrong target or a dangling link (codex-local `ensureSymlink` pattern; refresh tokens are single-use so a copy goes stale). Errors: `prime_host_auth_missing`, `prime_host_auth_unsafe`. `billingType`: read only the `type` field of the `provider` entry of the host file: `"oauth"` → `"subscription"`, `"api_key"` → `"api"`, anything else or no entry → `"unknown"`. Never log or return any other field. UNVERIFIED: the 0.10.0 OAuth entry uses `type: "oauth"` (Pi format).
3. `api_key`: key = `env[apiKeyEnvVar]`, trimmed; empty → `prime_api_key_missing`. Write `{ "<provider>": { "type": "api_key", "key": "<key>" } }` to a temp file in the agent dir opened with `wx` and mode `0600`, then `rename` over `auth.json` (this also replaces a symlink left from host mode). Re-check with `lstat`: regular file, not a symlink, owned by this uid, `mode & 0o077 === 0`; else `prime_auth_file_unsafe`. `billingType: "api"`. Verified 2026-10-18: Prime 0.10.0 `model list` accepts this file shape (fixture `model-list-api-key-anthropic.txt`).
4. Never fall back to the ambient `~/.prime/agent`, another provider or another model. Never put a key in notes, logs, `resultJson` or session params.

`createEphemeralPrimeAgentDir(credential)` makes `mkdtemp(<os.tmpdir()>/paperclip-prime-agent-)` (mode `0700`) and its `sessions/`, and returns a kind `"ephemeral"` plan plus `cleanup()`. It does not seed; the caller runs `seedPrimeAgentDir(plan, { provider, env })` on it like on an agent dir (`provider` may be `""` when unknown, as in `listModels`; `billingType` is then `"unknown"`). `cleanup()` removes the dir and never throws. Used by `testEnvironment` (its context has no agent id) and by `listModels`/`refreshModels` (no context at all). Ephemeral dirs never hold sessions that are reused.

## 4. Child environment: `buildPrimeChildEnv` (WP1)

```ts
buildPrimeChildEnv(base: NodeJS.ProcessEnv, plan: PrimeAgentDirPlan, paperclipEnv: Record<string, string>): { env; droppedKeys }
```

`paperclipEnv` is what pi-local builds before spawning: `buildPaperclipEnv(agent)` + `buildRuntimeToolsEnv` + run/task/wake vars + `refreshPaperclipWorkspaceEnvForExecution(...)` (which merges `config.env`, never `PAPERCLIP_API_KEY` from config) + `PAPERCLIP_API_KEY = ctx.authToken`.

Steps (L17, MASTER-PLAN "Environment hygiene"):
1. From `base`: drop `undefined` values, every key starting with `PRIME_STRIPPED_ENV_PREFIXES` (`PRIME_AGENT_`, `RLM_`, `PI_`; covers `PI_CODING_AGENT_DIR` and all `PRIME_AGENT_INTERNAL_*`), and every key in `PRIME_PROVIDER_CREDENTIAL_ENV_KEYS` (the host's ambient provider keys are blanked, codex pattern).
2. From `paperclipEnv`: drop keys starting with `PRIME_ALWAYS_STRIPPED_ENV_PREFIXES` (`PRIME_AGENT_INTERNAL_`, `RLM_`, `PI_`) and keys in `PRIME_ADAPTER_OWNED_ENV_KEYS`. Other operator-set `PRIME_AGENT_*` keys (for example `PRIME_AGENT_KERNEL_VENV`) and provider keys set in `config.env` are kept.
3. Merge: base, then paperclipEnv.
4. Set `PRIME_AGENT_CODING_AGENT_DIR = plan.agentDir` and `PRIME_AGENT_TELEMETRY = "0"`. `PRIME_AGENT_SESSION_DIR` stays unset (`--session-dir` is passed).
5. Apply `ensurePathInEnv`.
`droppedKeys` lists names only, sorted, never values. Pure function. A test pins that a base containing `PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN`, `RLM_SESSION_DIR`, `PI_CODING_AGENT_DIR`, `PRIME_AGENT_CODING_AGENT_DIR=/elsewhere` and `ANTHROPIC_API_KEY` produces none of them except the adapter's `PRIME_AGENT_CODING_AGENT_DIR`.

## 5. Arguments: `buildPrimeArgs` (WP3, `src/server/execute.ts`)

```ts
buildPrimeArgs(input: PrimeArgsInput): string[]
```

Exact order:

```
--mode json -p
--provider <provider> --model <model>
[--thinking <level>]                       when thinking != null
--cwd <cwd>
--session-dir <sessionDir>
[-r <resumeSessionFile>]                   when resuming
[--skill <dir>]...                         one per skillDirs entry, in order
[--append-system-prompt <text>]...         one per non-empty appendSystemPrompts entry, in order
[--no-context-files]                       when noContextFiles
...extraArgs
-- <prompt>
```

`--provider` and `--model` are always passed: with no settings Prime falls back to a Bedrock placeholder (fixture run1). `appendSystemPrompts` is built by execute as `[renderedInstructionsAndDefaultPolicy, config.appendSystemPrompt]` (pi-local's system-prompt extension first). Pure function; no validation beyond skipping empty append strings.
UNVERIFIED: `--` before the prompt with `-p` in json mode (help: "`--` Treat all following arguments as messages"); `-r <file>` together with `--session-dir`. WP7 confirms on the first real run; if either fails, the parent amends this section.

## 6. Output parsing: `parsePrimeJsonl` (WP2, `src/server/parse.ts`)

```ts
parsePrimeJsonl(stdout: string): ParsedPrimeOutput
isPrimeUnknownSessionError(stdout: string, stderr: string): boolean
```

Observed event stream (fixtures, prime-agent 0.10.0): `session` (`version: 3`, `id`, `timestamp`, `cwd`, `rlmDepth`), `agent_start`, `turn_start`, `message_start`/`message_update`/`message_end`, `tool_execution_start`/`tool_execution_end`, `turn_end` (`message`, `toolResults`), `agent_end` (`messages`). Message roles: `custom` (`customType: "harness_digest"`, `display: false`; absent on resume), `user`, `assistant`, `toolResult`. Assistant content items: `text`, `toolCall` (`id`, `name`, `arguments`). `message_update.assistantMessageEvent.type`: `text_start`, `text_delta`, `text_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`. `tool_execution_end.result` is an object `{ content: [{type:"text",text}], details: {...} }`.

Rules:
- Skip blank and non-JSON lines. Never throw.
- `sessionId`/`sessionCwd` from the first `session` event.
- Usage: sum `message.usage` over `turn_end` events whose `message.role === "assistant"` only. Never add `message_end` or `message_update` usage (each assistant message appears in both `message_end` and `turn_end`; L14). `usage` stays `null` when no assistant `turn_end` was seen. Each `-p` run reports only its own turns (run3 resume shows only the new turn), so execute reports `usageBasis: "per_run"`.
- Errors: an assistant message with `stopReason: "error"` in `message_end`, `turn_end` or `agent_end` adds `errorMessage` (or `"Prime provider request failed."`), deduplicated; `type: "error"` events add `message`; `auto_retry_end` with `success !== true` adds `finalError` (event shape from Pi, UNVERIFIED in Prime).
- `messages`: text of each assistant `turn_end` message with non-empty text. `finalMessage`: text of the last assistant message in `agent_end.messages`, else the last `messages` entry, else `null`.
- `lastStopReason`, `provider`, `model`: from the last assistant `turn_end` message.
- `toolCalls`: from `tool_execution_start`; `result`/`isError` from the matching `tool_execution_end` by `toolCallId`; `result` = joined text items of `result.content`, else `JSON.stringify(result)`.
- `sawAgentEnd`: `true` iff an `agent_end` event was seen.
- `isPrimeUnknownSessionError`: same regex family as pi-local (`unknown session`, `session not found`, `no session`). UNVERIFIED: Prime's actual wording for a missing `-r` file; WP2 records the message if it finds it without calling a model (for example `-r` to a missing path with an empty agent dir and `--provider`/`--model` of an unauthenticated provider must not reach a model; if unsure, leave the regex as pi-local's).

## 7. Session: params, codec, resume decision (WP4, `src/server/session.ts`)

`PrimeSessionParams = { sessionId, sessionFile, cwd, provider, model, agentDir }` (all non-empty strings; `sessionFile = <sessionDir>/<sessionId>.jsonl`, the file Prime writes under `--session-dir`). `agentDir` is the agent-dir identity from salvage C3(b), added to the parent's list.

`primeSessionCodec: AdapterSessionCodec`:
- `deserialize(raw)`: non-object or array → `null`. Ignore exactly `HOST_SESSION_METADATA_KEYS` and keys starting with `HOST_SESSION_METADATA_KEY_PREFIXES`. If only host keys are present, or any of the six fields is missing/empty → `null` (fresh session). Otherwise return the six fields only.
- `serialize(params)`: same validation; returns the six fields or `null`.
- `getDisplayId(params)`: `sessionId` or `null`.
No legacy aliases (`session_id`, `workdir`): this adapter has no stored history.

`readPrimeSessionHeader(sessionFile)`: first non-empty line parsed as JSON with `type === "session"` → `{ id, cwd }`; anything else (missing file, bad JSON) → `null`. Never throws.

`decidePrimeResume({ saved, current, header })` — pure, checks in this order: `saved === null` → `no_saved_session`; `cwd` differs (after `path.resolve`) → `cwd_mismatch`; `provider` or `model` differs → `model_mismatch`; `agentDir` differs → `agent_dir_mismatch`; `header === null` → `session_file_missing`; `header.id !== saved.sessionId` or (`header.cwd` set and differs from `current.cwd`) → `session_header_mismatch`; else `{ resume: true, sessionFile: saved.sessionFile }`. Stock pi-local binds only `cwd`; this adapter binds all of them (salvage C3(b)).

## 8. Models and version (WP4 `src/server/models.ts`, WP5 `src/server/version.ts`)

`prime-agent model list` facts (fixtures): stdout table, header `provider  model  context  max-out  thinking  images`, columns separated by 2+ spaces, padded rows with trailing spaces, column widths change with content. It lists only providers with a usable credential in the agent dir (3 with the host auth: anthropic 16, openai-codex 17, vercel-ai-gateway 242 rows; 16 with an anthropic API-key file; none with an empty dir). With no credential it prints `No models available. Use /login ...` and exits 0. It writes `auth.json` (`{}`) and `models/provider-model-catalog.v1.json` into the agent dir, so it must always run with `PRIME_AGENT_CODING_AGENT_DIR` set to a per-agent or ephemeral dir, never the host default.

- `parsePrimeModelList(stdout)`: pure. Skip the header and any line that does not have 6 columns when split on `/\s{2,}/` after `trimEnd()` (this drops the no-models message). `thinking`/`images`: `"yes"` → true. Return rows in output order.
- `listPrimeModels({ command, env, cwd })`: runs `<command> model list` (no search arg) via `runChildProcess`, timeout 20 s, grace 3 s; non-zero exit or timeout → `PrimeCliError("prime_model_list_failed")` with the first output line. Maps rows to `AdapterModel { id: "provider/model", label: id }`, deduplicated, sorted as pi-local. Cache 60 s keyed by command, cwd, agent dir and a hash of the env (pi-local `discoveryCacheKey`). Throws `PrimeCliError("prime_cli_missing")` when the command cannot be spawned.
- `listPrimeModelsForAdapter()` / `refreshPrimeModelsForAdapter()`: `createEphemeralPrimeAgentDir({ mode: "host_auth", hostAuthFile: <default> })`, `seedPrimeAgentDir(plan, { provider: "", env: {} })`, `buildPrimeChildEnv(process.env, plan, {})`, `listPrimeModels`, then cleanup; refresh bypasses the cache. Any failure → `[]`. The list therefore shows what the host Prime credential can reach; an `api_key` agent is checked against its own credential by `testEnvironment` and `execute`.
- Model check used by execute and testEnvironment: `modelRef` must equal one listed `id`; else `PrimeCliError("prime_model_unknown")` with up to 12 sample ids. Listed does not mean entitled (salvage §2.5).
- `detectPrimeModel(agentDir)`: reads `<agentDir>/settings.json`; returns `{ provider: defaultProvider, model: "<defaultProvider>/<defaultModel>", source: "<agentDir>/settings.json" }` only when both are non-empty strings, else `null`; never throws. A fresh Prime `settings.json` has both `null` (observed). `detectPrimeModelForAdapter()` = `detectPrimeModel(<os.homedir()>/.prime/agent)` with `source: "~/.prime/agent/settings.json"`. It only reads.
- `readPrimeVersion({ command, env, cwd })` (WP5): runs `<command> --version`, timeout 10 s; returns the first line trimmed (fixture: `0.10.0`). Spawn failure → `PrimeCliError("prime_cli_missing")`; other failure or a line that is not `x.y.z` → `prime_cli_version_unreadable`.
- `isSupportedPrimeVersion(v)` (WP5): `PRIME_SUPPORTED_VERSION_RANGE.min <= v < maxExclusive` by numeric semver core (pre-release suffix → false). Pure.

## 9. Skills (WP4, `src/server/skills.ts`)

Mode `ephemeral` (MASTER-PLAN; Paperclip "tmpdir + flag" pattern).
- `listPrimeSkills(ctx)` / `syncPrimeSkills(ctx, desired)`: both return `buildRuntimeMountedSkillSnapshot({ adapterType: "prime_agent_local", availableEntries: readPaperclipRuntimeSkillEntries(ctx.config, moduleDir), desiredSkills: resolveLegacyPaperclipDesiredSkillNames(ctx.config, entries), configuredDetail: "Passed to Prime with --skill on the next run." })`. `syncPrimeSkills` ignores its `desired` argument and writes nothing (claude-local pattern). Desired skills are `configured`, never `installed` (salvage §2.2).
- `stagePrimeSkills(config)`: `mkdtemp(<os.tmpdir()>/paperclip-prime-skills-)`; for each desired entry whose source is present (`!isPaperclipSkillSourceMissing`), symlink `<tmp>/<runtimeName> -> entry.source`; return those paths as `skillDirs` (one `--skill` each), missing desired ones in `missing`. `cleanup()` removes the temp dir, never throws. On a staging error, remove the temp dir and throw the original error (cleanup error as `cause` only, R-27). Nothing is written to the agent dir or `~/.prime`.
UNVERIFIED: Prime 0.10.0 follows a symlinked skill dir and accepts a skill dir (with `SKILL.md` at its root) as `--skill`. The run4 fixture shows a skill loaded via `--skill` from a tmp dir; the exact argument form used was not recorded.

## 10. Environment test (WP5, `src/server/test.ts`)

`testEnvironment(ctx: AdapterEnvironmentTestContext)` returns `{ adapterType: ctx.adapterType, status, checks, testedAt }`, status `fail` if any error, else `warn` if any warn, else `pass`. No model call (no hello probe) and no claim of account entitlement. Checks in order; codes are `PrimeCheckCode`:

| Step | Pass | Fail |
|---|---|---|
| execution target | local or absent | non-local → `prime_config_invalid` (error, "remote execution targets are not supported in phase 1") |
| config | - | `resolvePrimeRuntimeConfig` throws → `prime_model_required` / `prime_model_invalid` / `prime_thinking_invalid` / `prime_config_invalid` (error, message from the error) |
| cwd (`config.cwd` or `process.cwd()`) | `prime_cwd_valid` (info) | `prime_cwd_invalid` (error; never created) |
| CLI | `prime_cli_found` (info, resolved command) | `prime_cli_missing` (error) |
| version | `prime_cli_version` (info, "prime-agent 0.10.0") | `prime_cli_version_unsupported` (error) / `prime_cli_version_unreadable` (error) |
| credential | `prime_auth_host_linked` (info, host file present and safe; billing class only) / `prime_auth_api_key` (info, env var present; value never shown) | `prime_auth_missing` (error) / `prime_auth_unsafe` (error) |
| model list (ephemeral dir seeded with the configured credential) | `prime_models_discovered` (info, count) | `prime_models_empty` (warn) / `prime_models_discovery_failed` (warn) |
| configured model | `prime_model_listed` (info, "listed; entitlement is proven only by a run") | `prime_model_unknown` (error; refuse-before-spawn rule) |

Later steps that depend on a failed earlier step are skipped without a check entry, except the model steps, which still run if only the credential check warned. `testEnvironment` never writes outside its ephemeral dir and always cleans it up.

## 11. Execute (WP3, `src/server/execute.ts`)

Follows pi-local `execute.ts` for workspace/cwd resolution, Paperclip env, prompt assembly (`selectPaperclipPromptSections`, templates, instructions file, session handoff note), `onMeta`, line-buffered `onLog`, and the unknown-session retry. Prime-specific contract:

1. Budget: `timeoutSec` starts when `execute` starts (before seeding), not at spawn (salvage C1.3).
2. Non-local `executionTarget` → preflight failure. `ctx.signal?.aborted` is checked before each pre-spawn step and right before spawn; never spawn after abort (→ `prime_run_cancelled`).
3. Pre-spawn, in order: `resolvePrimeRuntimeConfig` → `readPrimeVersion` + `isSupportedPrimeVersion` → `seedPrimeAgentDir` → `buildPrimeChildEnv` → model check (`listPrimeModels` in the agent dir) → `stagePrimeSkills`. Any failure returns `{ exitCode: 1, signal: null, timedOut: false, errorCode: "prime_preflight_failed", errorMessage: <original message>, errorMeta: { primeErrorCode }, clearSession: false }` (salvage `bootstrapFailure`). Cleanup failures never replace the original error (L10, R-27).
4. Resume: `primeSessionCodec.deserialize(runtime.sessionParams)` → `readPrimeSessionHeader` → `decidePrimeResume`. Not resuming with saved params → log one `[paperclip]` line with the reason. A fresh session passes no `-r`; the new session id comes from the `session` event.
5. Spawn `buildPrimeArgs(...)` with `runChildProcess` (local), `cwd` = execution cwd, `env` = `buildPrimeChildEnv(...).env`. Skills temp dir is removed in `finally`.
6. Unknown session on a resumed attempt (`isPrimeUnknownSessionError`) → one fresh retry, result `clearSession: true` (pi-local).
7. Result mapping (salvage §2.1 `terminalResult`, MASTER-PLAN decisions):
   - timed out → `timedOut: true`, `errorCode: "prime_run_timeout"`, no `sessionParams`, `clearSession: false`.
   - `sawAgentEnd === false` (killed, crashed, lost) → `exitCode` as observed or `1`, `errorCode: "prime_run_uncertain"`, never success, no new `sessionParams`, `clearSession: false` (L8).
   - assistant error (`errors.length > 0`) or non-zero exit → `exitCode` = raw or `1`, `errorCode: "prime_run_failed"`, `errorMessage` = first parsed error, else first stderr line, no `sessionParams`, `clearSession: false`.
   - completed → `exitCode: 0`, `sessionParams` (§7, from the `session` event id and the session dir), `sessionDisplayId: sessionId`, `summary: finalMessage`.
   - Always when known: `provider`, `model` (`modelRef`), `biller` (= provider), `billingType` from seeding, `usage: { inputTokens, outputTokens, cachedInputTokens }` only when `parsed.usage !== null`, `usageBasis: "per_run"`, `costUsd` = `usage.reportedCostUsd` when `billingType === "api"` and `> 0`, else `null`. `resultJson` = `{ stdout, stderr, cacheWriteTokens, totalTokens }` (no secrets; stdout is Prime's own output).
8. After return, no `prime-agent` process started by this run is alive (L9). UNVERIFIED: whether `--mode json -p` starts a daemon or kernel that outlives the CLI; the read-only probes in WP0 left no process behind. WP7 verifies with a real run.

## 12. UI parser, UI, CLI, config schema (WP6)

- `src/ui-parser.ts` → `dist/ui-parser.js`: exports `createStdoutParser()` and `parseStdoutLine(line, ts)`. Zero imports (not even type imports from packages; declare a local entry type), no side effects at module level, never throws (unknown line → `{ kind: "stdout" }`), deterministic, < 50 KB. Input lines are Prime JSONL events (§6) plus adapter lines starting with `[paperclip]` (→ `system`).
  Mapping: `session` → `init` (`model` from the last known assistant model or `""`, `sessionId`); `message_end` assistant → `thinking` then `assistant` (text) and one `tool_call` per `toolCall` item (`toolUseId` = item id, `input` = `arguments`); `message_end` user → `user`; `tool_execution_end` → `tool_result` (`toolUseId`, `toolName`, text content, `isError`); assistant `stopReason: "error"` → `stderr` with `errorMessage`; `agent_end` → `result` (summed usage of the stream, `isError` if an error was seen). Ignore `message_start`, `message_update`, `turn_start`, `turn_end`, `agent_start`, custom-role messages and `toolResult`-role messages (no duplicates: final text comes from `message_end` only).
- `src/ui/index.ts`: `parsePrimeStdoutLine(line, ts): TranscriptEntry[]` (same mapping, may import types) and `buildPrimeLocalConfig(values: CreateConfigValues)` (pi-local `build-config.ts` shape plus `credentialMode`/`apiKeyEnvVar` from `adapterSchemaValues`; `timeoutSec: 0`, `graceSec: 20`).
- `src/cli/index.ts`: `printPrimeStreamEvent(raw, debug): void` with picocolors (pi-local `format-event.ts` pattern).
- `src/server/config-schema.ts`: `getPrimeConfigSchema(): AdapterConfigSchema` with fields `credentialMode` (select host_auth/api_key, default host_auth), `apiKeyEnvVar` (text), `thinking` (select, `PRIME_THINKING_LEVELS`), `appendSystemPrompt` (textarea), `noContextFiles` (toggle), `agentDirRoot` (text). UNVERIFIED: how the host UI merges schema fields with its generic model/cwd/instructions fields for external adapters.

## 13. Fixtures (`test/fixtures/`)

See `test/fixtures/README.md`. Real captures from prime-agent 0.10.0; `/tmp` paths and session ids are left as captured. The four `prime-jsonl/run*.jsonl` files are pinned by sha256 in `test/contract.test.ts`.

## 14. UNVERIFIED register

1. `--` before the prompt with `-p` (§5). 2. `-r <file>` with `--session-dir` (§5). 3. Location of `session-artifacts/` (§3). 4. Host OAuth `auth.json` entry `type` value (§3). 5. Prime's wording for an unknown/missing resume session (§6). 6. `auto_retry_end` event in Prime (§6). 7. `--skill` with a symlinked skill dir (§9). 8. Whether a run leaves a daemon or kernel process (§11). 9. Refresh serialization when several agent dirs symlink one host `auth.json` (MASTER-PLAN decisions; WP7). 10. Provider → env var mapping of `PRIME_PROVIDER_CREDENTIAL_ENV_KEYS` (names from binary strings). 11. Host UI handling of `getConfigSchema` for external adapters (§12). 12. Thinking content shape in Prime events (fixtures run with thinking off; Pi uses `{ type: "thinking", thinking }`).

## 15. Change control

Changes to this file or `src/types.ts`/`src/errors.ts` are made only by the parent on `main`, with a commit message `interfaces: ...` and a note in the affected WP plans.

## 16. Parent amendments (after WP0 freeze)

- A1 (2026-10-18, from WP2 plan §9.2): `isError` for a tool call is read from the `toolResult` event and from `turn_end.toolResults`, not from `tool_execution_end` (Prime 0.10.0 has no `isError` there). §6 is read with this correction.
- A2 (from WP2 §9.1, verified by a network-isolated probe): `-r <unknown id>` exits 1 with "Error: No session found matching '<id>'" (pi-local unknown-session regex matches). `-r <missing path>` silently starts a NEW session at that path; `-r <existing non-session file>` OVERWRITES it. Therefore WP3 resumes only when the §7 header check passes on an existing session file, and never passes a non-existent path to `-r`. §14.5 resolved.
- A3 (parent observation, run5): Prime reports a non-zero `usage.cost` on a subscription run when `--append-system-prompt` is used (0.0132 USD, cacheWrite priced) while runs 2-4 report 0. Prime's cost field is an estimate, not a charge. The `costUsd` rule stays: only when `billingType` is api-key; otherwise null. The fixtures README must list run5 with this note (WP2 may add the README line; it is in WP2's fixture scope).
- A4: usage is `null` until an assistant `turn_end` carries a `usage` object (both wordings in §6/types.ts mean this).
- A5 (from WP6 plan §9.2): the UI parser and the server parser take tool results from the `toolResult`-role `message_end` event (text + `isError`), and ignore `tool_execution_start/update`; `tool_execution_end` is used only for pairing when present. Same source everywhere (A1).
- A6 (from WP6 §9.7): the host UI writes external-adapter config through `buildSchemaAdapterConfig`, so thinking arrives as `thinkingEffort`. WP1 `resolvePrimeRuntimeConfig` reads `thinking` first, then `thinkingEffort`; empty string means "Prime default" (no `--thinking` flag). The config schema's thinking select has a first option "" labelled "Prime default".
- A7 (from WP6 §9.9): the host does not load external `./cli` exports. `src/cli` is kept minimal (pi-local shape) for parity and tested, but nothing depends on it.
- A8 (from WP4 §9.1, verified in server-utils.js runChildProcess): the host spawns with `{...sanitizeInheritedPaperclipEnv(process.env), ...opts.env}` and then DELETES every key whose value is `undefined`. So `buildPrimeChildEnv` must return the stripped keys (every inherited `PRIME_AGENT_*` except the adapter-owned ones, `RLM_*`, `PI_*`, `PI_CODING_AGENT_DIR`, provider key vars) as explicit `undefined` entries, not omit them; the return type is `Record<string, string | undefined>`. Every direct `spawn` in the adapter (listPrimeModels, readPrimeVersion) applies the same rule by building its env as `{...process.env, ...childEnv}` and dropping undefined. Test: a base env with `PRIME_AGENT_INTERNAL_X=1`, `PI_CODING_AGENT_DIR=/x`, `OPENAI_API_KEY=k` yields those keys present with value undefined.
- A9 (from WP4 §9.2/§9.3): `listPrimeModelsForAdapter` uses a module-level 60 s cache keyed by command; `refreshModels` bypasses it; `resetPrimeModelsCacheForTests` is a test-only export. `assertPrimeModelListed(modelRef: string, models: PrimeModelInfo[]): void` (throws PrimePreflightError code `prime_model_unknown`) is frozen in §8 and used by WP3 execute and WP5 testEnvironment.
- A10 (from WP4 §9.6): skill runtime names must be a single path segment (no `/`, `\`, `..`); otherwise the skill is reported in `missing` with a reason and never linked.
- A8 (corrected wording, supersedes the "{...process.env, ...childEnv}" sentence): the `undefined` entries must reach `runChildProcess` UNCHANGED; runChildProcess merges `process.env` first and deletes undefined keys only after that merge. No adapter code builds its own env from process.env or drops undefined entries before the call. All adapter spawns (execute, listPrimeModels, readPrimeVersion) go through runChildProcess. `PrimeChildEnv.env`, `ListPrimeModels.env`, `ReadPrimeVersion.env` are `Record<string, string | undefined>` (types.ts amended by the parent).
- A9 (corrected names): the model entry type is `AdapterModel` (adapter-utils) and the thrown error is `PrimeCliError("prime_model_unknown", ...)`; there is no PrimeModelInfo or PrimePreflightError.
- A11 (from WP7 §9.1): the local-path plugin install route on this host is `POST /api/adapters/install` with `isLocalPath`, not `POST /api/adapters`.
- A12 (from WP7 §9.2): Prime's kernel venv lives at `$HOME/.prime/agent/kernel-venv` (per server HOME), not in the per-agent dir; `session-artifacts` sits next to `--session-dir`. Phase 1 accepts the shared kernel venv; the docs state it. UNVERIFIED register updated.
- A13 (from WP7 §9.5): API-created agents default to `maxConcurrentRuns` 20, so Paperclip does NOT serialize runs per agent by default. The adapter does not add its own lock in phase 1; the docs and the smoke script set `maxConcurrentRuns: 1` on prime_agent_local agents and recommend it. Two different agents sharing the symlinked subscription is the concurrency case WP7 checks.
- A8 (typing note): adapter-utils declares runChildProcess `opts.env` as `Record<string, string>`; pass the child env with `env as Record<string, string>` and a comment citing A8 (the runtime deletes undefined entries after its merge). Applies to execute, listPrimeModels, readPrimeVersion.
- A14 (from WP5 §9.1): testEnvironment check codes are `PrimeCheckCode | PrimeCredentialErrorCode` (a seeding failure reports the thrown credential code, or `prime_agent_dir_unsafe` for any other error). No mapping onto other codes.
