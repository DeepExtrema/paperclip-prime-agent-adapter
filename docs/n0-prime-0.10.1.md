# N0: Prime Agent 0.10.1 offline facts (TAI-273 plan rev 4, section 5 step 2)

Recorded by Nexus on 2026-10-25 for TAI-323. Item 16 and contradictions 7 and 8 were added the same day, for the five N0 lines new in plan rev 5 (revision `38d350eb`). Item 17 holds addenda A and B from Axiom's checkpoint answer. Every fact below was observed on this host, offline, with the scripts in `scripts/n0/`, unless it is marked `unverified` or "from the binary's strings".

## How the facts were taken

- **Binary:** `/home/extremis/.local/share/prime-agent/releases/0.10.1-linux-x64-21ec219183f4134dd23dce9572102e69456066fe374846525561c776d4d1945c/prime-agent` (`--version` prints `0.10.1`; daemon hello: protocol 7, schema revision 30, `buildId` `pa-daemon-rs-0.10.1`).
- **No network:** every Prime process ran under `scripts/n0/offline.sh`, a private network namespace with loopback only, as the calling user. Nothing in it can reach Anthropic or any other host.
- **No model:** `scripts/n0/fake-anthropic.mjs` is a scripted stand-in for the Anthropic Messages API on `127.0.0.1`. `models.json` in the scratch agent dir points the built-in `anthropic` provider at it. It can return text, `python_repl` tool calls, delays, 401 and 429.
- **Scratch dirs and fake keys:** each test has its own `HOME` and `PRIME_AGENT_CODING_AGENT_DIR` under `/tmp/n0-tai323/`. `auth.json` holds `sk-ant-api03-N0FAKEKEY-…` or `sk-ant-oat01-N0FAKEKEY-…`. `/home/extremis/.prime/agent/auth.json` was never read, copied or printed.
- **One exception to "no network", for the kernel build only (item 12):** uv needs PyPI and a CPython download once. That test ran in the same namespace with an allow-list proxy (`scripts/n0/egress.mjs`) reached through a Unix socket. It allowed only PyPI, `files.pythonhosted.org`, GitHub and astral hosts, and it logged every host asked for. The log shows no Anthropic host. The refusals were 3 × `raw.githubusercontent.com` (see "New facts") and one plain-HTTP request to the fake server on `127.0.0.1`, which was sent to the proxy because `NO_PROXY` was not set yet. All later tests reuse that venv fully offline.
- **Reproduce:** `npm run build`, then for example `N0_ROOT=/tmp/n0 N0_KERNEL=/tmp/n0/kernel scripts/n0/offline.sh node scripts/n0/e05-end-session.mjs kill child`. Each `eNN-*.mjs` file states what it shows.

## Answers, in the order of the plan's N0 list

### 1. Settings field names; the retry object; memory with autoRefine off

| Key | 0.10.1 fields | Evidence |
|---|---|---|
| `autoRefine` | `enabled`, `turnInterval`, `compact`, `cooldownMs` | The binary has `struct AutoRefineSettings with 4 elements` and the strings `turnInterval compact cooldownMs` in its settings field run. The 0.7.1 source (`settings-manager.ts:23-28`) has the same four fields: `enabled` default true, `turnInterval` 25, `compact` true, `cooldownMs` 20 min. **Behaviour unverified:** with `{enabled:true, turnInterval:1, cooldownMs:0}`, 11 assistant turns and a daemon stop made no review request (e17), with and without `serializedRefine`. So I could not show that `enabled:false` is what stops it. |
| `factory` | `enabled` | `struct FactorySettings with 1 element`. The kernel reads `settings.json` → `factory.enabled is True` (`rlm/factory.py:3756-3784`; it reads the agent dir's file only). The default is off: `create_factory` fails with "the factory is disabled; run /factory on to enable it" (e09). |
| `telemetry` | `enabled`; also `noticeShown` and probably `localMirror` | `prime-agent telemetry off` writes `{"telemetry":{"enabled":false}}` (e15). `struct TelemetrySettings with 3 elements`. `DO_NOT_TRACK=1` forces it off whatever the settings say ("forced off by DO_NOT_TRACK"). |
| `agentTraces` | `enabled` | `struct AgentTracesSettings with 1 element`; 0.7.1 `agentTraces.enabled`, default false. Not exercised. |
| `retry` | top level: `enabled`, `maxRetries`, `baseDelayMs`, `provider`, and a fifth field (probably `failover`). `provider`: `timeoutMs`, `maxRetryDelayMs`, `waitForUsage`. `waitForUsage`: 8 fields, of which the strings give `baseDelayMs`, `maxDelayMs`, `maxAttempts`, `maxWaitMs`, `pauseUntilReset`, `maxPauseMs` | Behaviour (e18, fake 429 with `retry-after: 1`): `{retry:{enabled:false}}` → no retry; `{retry:{maxRetries:1}}` → exactly 1 retry; `{retry:{provider:{maxRetryDelayMs:500}}}` → no retry (the server asked for 1000 ms); the default is 3 retries at about 2 s, 4 s and 8 s, or at `retry-after` when the server sends one. **A partial `retry` object keeps every other default:** `{retry:{provider:{waitForUsage:{enabled:false}}}}` still gave 3 retries. The prompt "…will resume automatically (retry.provider.waitForUsage.pauseUntilReset)" confirms that path. |

**The waitForUsage park was never triggered.** A fake 429 (with `retry-after: 30`, `anthropic-ratelimit-unified-status: rejected` and a reset 1 h ahead) was retried 3 times and then failed the turn. `isQuotaParked` stayed false with the default settings (api key and `sk-ant-oat` key, e11) and with `{retry:{provider:{waitForUsage:{enabled:true, pauseUntilReset:true}}}}`. So whether `waitForUsage` is on by default, and which `waitForUsage` field turns it off, is `unverified`. A real subscription usage-limit 429 may carry a signal my fake does not send.

**Memory with autoRefine off works.** `{harnessRefinements:true, autoRefine:{enabled:false,…}}`: `rlm.harness.create_memory(…, global_=True)` and `search` work (e17). `{harnessRefinements:false}`: `create_memory` raises (F7 confirmed).

### 2. A skill whose name does not match its directory

**It loads, with no warning in any log or stderr I could see** (e12). The create config's `skills` had `simplified-english--9876d8956d/SKILL.md` with `name: simplified-english`. It appears in `<available_skills>` as `<name>simplified-english</name>` with its real location, and in `get_commands` as `skill:simplified-english`.

Also: **a config skill named like a built-in replaces the built-in.** A staged `goal/SKILL.md` took the place of Prime's own `goal` skill in `<available_skills>`; the built-in `goal` entry was gone.

### 3. The command that ends one session so that a later wake fails

`agent_message.send` (the agent-message skill) was used to wake each session after the command (e05, e22, e23).

| Session | Command | Result | Wake afterwards |
|---|---|---|---|
| depth-1 child, idle | `delete_rlm_subagent {activeSessionId: <parent>, childId: <rlmChildId>}` | removed from the roster | **refused**: "No child matches" |
| depth-1 child, idle | `kill {activeSessionId: <child>}` | removed from the roster | **succeeds**: the child comes back under a **new `activeSessionId`** with the **same `sessionId`**, and runs a turn |
| depth-1 child, idle | `cancel_rlm_child {activeSessionId: <parent>, childId}` | stays | succeeds, runs a turn |
| depth-1 child, idle | `abort {activeSessionId: <child>}` | stays | fails: "Cannot admit a session action while queued session input is suspended" (the session is not ended) |
| depth-1 child, **mid-turn** | `delete_rlm_subagent` | **refused**: `{deleted:false, reason:"running"}` | — |
| depth-1 child, mid-turn | `cancel_rlm_child` (or `abort` on the child), **then** `delete_rlm_subagent` | `{cancelled:true}`, then `{deleted:true}` within 50 ms | **refused**: "No child matches" |
| depth-1 child, mid-turn | `kill`, then `delete_rlm_subagent` | delete keeps answering `running` for 5 s | **succeeds** |
| depth-0 `create_session` session, idle or mid-turn | `kill {activeSessionId: <session>}` | removed from the roster at once | **refused**: "No sibling matches" |
| depth-0 `create_session` session | `delete_rlm_subagent` / `cancel_rlm_child` | `success:true`, but nothing changes | succeeds |

So **no single command works for both kinds.** Depth ≥ 1: `cancel_rlm_child` then `delete_rlm_subagent`, both sent with the child's parent `activeSessionId` and the child's `rlmChildId`. Depth 0: `kill`.

### 4. Roster rows; old children after a resume

- **A `create_session` row:** `rlmDepth: 0`, `runtimeKind: "top-level"`, `sessionName` set, `parentSessionPath` = the creator's session file, no `parentActiveSessionId` and no `rlmChildId`. Its session file is in the agent's `sessions/` dir, next to the parent's. A depth-1 row has `runtimeKind: "subagent"`, `parentActiveSessionId`, `parentSessionId`, `rlmChildId` (`sub-…`), and its file is `<agentDir>/session-artifacts/<parentSessionId>/<rlmChildId>/<sessionId>.jsonl`.
- **A fresh daemon does not list a resumed parent's old children.** After `create` with `sessionPath`, the first `list` holds only the parent (e06). The old sibling session is not listed either.
- **An old child can be woken there; an old sibling session cannot.** `rlm.list_subagents()` in the resumed parent still lists the old child. `agent_message.send(…, receiver_role="child")` woke it. It appeared in the roster as a new row (new `activeSessionId`, same `sessionId` and `rlmChildId`, no `parentActiveSessionId`) and ran a turn. A send to the old sibling failed with "No sibling matches".

### 5. `list` during a pending wait; RosterSubscribe

- **`list` runs on the same client while `prompt_and_wait` is pending** (answered in 1–3 ms, e07) **and while `wait_for_headless_completion` is pending** (1–2 ms, e19).
- `wait_for_headless_completion` returns within 2 ms when no goal and no autonomous loop is running. **It stays pending while a goal is active**, for as long as the goal keeps re-prompting (e08, e19). `abort` releases it.
- **`roster_subscribe` delivers `roster_update` events during a turn.** The reply to `roster_subscribe` carries the current roster. Then `roster_update {changed:[…]}` events arrive on every activity change of every session, child rows included, while the parent's turn runs (e05: 13–29 events per test). `roster_unsubscribe` exists.

### 6. Where `scheduled-jobs.json` lives

`<PRIME_AGENT_CODING_AGENT_DIR>/session-artifacts/<sessionId>/scheduled-jobs.json`, written by `rlm_heartbeat.create(…)` (e09; `interval="1h"` is refused, `"@hourly"` works). **A resumed session re-registers it:** after a fresh daemon resumed that session, `heartbeats_list` listed the heartbeat again. A new session did not.

### 7. Goals

- **State in the session file:** `custom` entries with `customType: "thread_goal_state"`, the newest one winning. `data` is `{active, status, goalId, objective, tokensUsed, timeUsedSeconds, continuationsUsed, createdAt, noProgressStreak, updatedAt}`; status `active` while pending. Each re-prompt is a `custom_message` with `customType: "goal_context"`, whose text begins `[goal: continuation]`.
- **A goal set by the model re-prompts without pause.** With instant fake answers, one `goal.create` led to 1,421 continuation turns in 2 minutes (e08, first run).
- **`create` with `sessionPath` started no turn.** The session had an active goal and its continuation was owed: the continuation was unanswered when the first daemon stopped. A fresh daemon made no model request in the 8 s after `create`, and the session stayed idle (e08).
- **A clear command from outside the model exists.** `prompt_and_wait` with the message `/goal clear` is handled as a slash command, with **no model request**. The session file gets `session_slash_command`, then `session_slash_command_result` "Goal cleared.", then `thread_goal_state {active:false, status:"idle"}`. `goal.get()` then returns `goal: None`, and no continuation follows (e08). There is no daemon command for goals (`goal`, `clear_goal`, `set_goal` and the like are "Unknown daemon command"). Not tested: clearing a `paused` goal.

### 8. Harness paths and which kinds reach a later session

- **Kernel stores** (`rlm.harness.*`, e09, e20): global `<agentDir>/harness/harness_state.json`; local `<agentDir>/session-artifacts/<sessionId>/harness/harness_state.json` (`RLM_HARNESS_STATE_DIR`). Top-level keys: `schema`, `entries` (`prompt`, `memory`, `skill`, `subagent`, `factory`), `refinements`.
- **Host-side refine stores** (`refine.run(…)` from the model, and the daemon `refine` command; e20, e21): global `<agentDir>/harness_state.json` and `<agentDir>/refinement_history.jsonl` (one JSON line per refinement); local `<agentDir>/sessions/harness/harness_state.json`. No session `refinement_history.jsonl` appeared. These are **not** the kernel's paths.
- **Every global kernel entry kind reaches a new session.** The first user message of every new session, and of every resumed one, starts with a `[harness-digest]` block. It holds every global `prompt`, `memory`, `skill` and `subagent` entry by title and content (e09; `factory` was not tested, because the factory is off). The prompt notes are introduced as "supplemental notes". A resumed session also gets its own local entries. None of this is in the system prompt; it is user-message text.
- **The refine store's edits did not reach a new session.** A global prompt edit applied by `refine.run(global_=True)` was written to `<agentDir>/harness_state.json`. It did not appear anywhere in the next new session's first request (e21). This contradicts F7, which says refine's global edits reach every later session. Whether the session that ran the refine sees the edit was not tested.

### 9. What 0.10.1 loads from `<cwd>/.prime/agent/` and from `cwd`

Read from the first model request's system prompt (e12, e13, e13b).

| Source | Loaded |
|---|---|
| `<cwd>/.prime/agent/SYSTEM.md` | yes, **replaces the whole system prompt**, and wins over `<agentDir>/SYSTEM.md` |
| `<cwd>/.prime/agent/APPEND_SYSTEM.md` | yes |
| `<cwd>/.prime/agent/skills/<name>/SKILL.md` | yes, in `<available_skills>` |
| `<cwd>/.prime/agent/prompts/*.md` | yes, as a prompt command |
| `<cwd>/.prime/agent/settings.json` | yes for some keys. **A project scalar wins over the agent dir's:** `defaultThinkingLevel` low (project) beat medium (agent dir). `rlmMaxDepth` is read from the agent dir only. |
| `<cwd>/.prime/agent/AGENTS.md`, `<cwd>/.prime/agent/models.json` | no |
| `<cwd>/AGENTS.md` | yes |
| `<cwd>/CLAUDE.md` | yes when that dir has no `AGENTS.md`; with both, only `AGENTS.md` |
| **`AGENTS.md` / `CLAUDE.md` in every ancestor of `cwd`** | **yes, up the whole tree**; three levels up, and past a `.git` dir (e13) |
| `<agentDir>/AGENTS.md` | yes |
| `<agentDir>/APPEND_SYSTEM.md` | no (as Sentinel found) |

Today no `AGENTS.md` or `CLAUDE.md` exists in `/home/extremis/.paperclip/instances/default/workspaces`, in any of its parents, or in `/` (checked for existence only).

### 10. The full settings key list, and keys Prime writes in a normal daemon run

**Top-level keys of 0.10.1** (the binary's settings serializer field run, in order): `onboardingShown`, `onboardingCompleted`, `defaultProvider`, `defaultModel`, `subagentDefaultModel`, `updateChannel`, `recentModels`, `auxiliaryModel`, `defaultThinkingLevel`, `defaultServiceTier`, `rlmMaxDepth`, `idleEvictionMinutes`, `steeringMode`, `followUpMode`, `theme`, `autoRefine`, `harnessRefinements`, `agentTraces`, `telemetry`, `retry`, `providerBackupModel`, `imageModel`, `autonomous`, `shellPath`, `quietStartup`, `shellCommandPrefix`, `npmCommand`, `mcpServers`, `mcpCatalogSources`, `skills`, `prompts`, `themes`, `enableSkillCommands`, `bundledSkills`, `enableBuiltinSkills`, `images`, `enabledModels`, `allowedModels`, `treeFilterMode`, `chatDetail`, `thinkingBudgets`, `editorPaddingX`, `autocompleteMaxVisible`, `showHardwareCursor`, `sessionDir`, `requestTiming`.

The binary also has settings structs whose key names are shorter strings stored elsewhere, so they are missing from that run: `compaction`, `branchSummary`, `terminal`, `markdown`, `warnings`, `factory`. These keys are known from 0.7.1 and other code: `packages` (Sentinel saw it run `npm`), `extensions` and `transport`. `hideThinkingBlock` (0.7.1) is not in the 0.10.1 binary. Prime parses `settings.json` one key at a time and **silently ignores a key with a bad value**; an unknown key is ignored too (e03, e14). So the list cannot be checked by a parse error, and `unverified` applies to completeness.

**Keys Prime writes in a normal daemon run: none** (e10). I ran this worktree's adapter `execute()` twice against 0.10.1, the second run resuming the first, with daemon runtime, `api_key` mode, `allowedModels`, `subagentDefaultModel` and `rlmMaxDepth`. The sha256 of `settings.json` after each run equalled the adapter's own write. In every direct daemon test `settings.json` also stayed `{}`. Prime does write `<agentDir>/telemetry.json` (`{version, installationId}`), even with telemetry off.

### 11. Does Prime itself write under `<agentDir>/skills/`?

**No.** No test, including the two adapter runs, created `<agentDir>/skills/`. 2.2 item 9's condition holds. The kernel venv build installs the bundled skills into the venv, not into the agent dir.

### 12. Kernel paths from `adapterConfig.env`

**Prime honours all three keys** (e02). With `PRIME_AGENT_KERNEL_VENV=<k>/venv`, `UV_PYTHON_INSTALL_DIR=<k>/python` and `UV_CACHE_DIR=<k>/uv-cache` in its env:

- `sys.executable` in the kernel is `<k>/venv/bin/python`.
- `readlink -f <k>/venv/bin/python` is `<k>/python/cpython-3.11.16-linux-x86_64-gnu/bin/python3.11`, which is under the durable dir.
- Nothing was written under the scratch `HOME`'s `.prime`, `.local/share/uv` or `.cache/uv`.
- A second start with a new scratch `HOME` and **no network at all** reused the venv: the first `python_repl` call returned in 0.24 s, with no "setting up python kernel" line.

The full adapter `execute()` (e10) passed these keys through `adapterConfig.env`, and its kernel started from the durable venv: `kernel-state.json` shows Python 3.11.16, there was no "setting up" line, and the scratch `HOME` stayed empty. The first build took about 10 s with a warm uv cache. The cold build time was not measured, because my first attempt was cut short.

### 13. Do daemon workers lead their own process group?

**Yes.** Each worker's PGID equals its PID, and its session id is the daemon's (`ps -o pid,pgid,sid`, e05). So `signalGroup(workerPid)` reaches a worker's own group, and a `kill -<daemonPid>` alone does not.

### 14. Events and texts for a 401 and a 429

- **401** (e11): `prompt_and_wait` fails with `error: "Provider authentication failed (authentication_error, 401): <provider message> [request_id: <id>]"`. The assistant message has `stopReason: "error"`, the same `errorMessage`, and `diagnostics[0] = {type:"provider_stream_failure", details:{kind:"auth", providerErrorType:"authentication_error", status:401, requestId}}`. Prime retries **once**: `auto_retry_start {attempt:1, maxAttempts:3, delayMs:~1700}`, then `auto_retry_end {success:false, attempt:1, finalError}`, then a `custom` message `provider_retry_outcome` "⚠ Error: Retry failed after 1 attempts: …". The session ends idle.
- **429** (e11, e18): the text is `"Provider rate limit exceeded (rate_limit_error, 429): <provider message> [request_id: <id>]"`, and the diagnostic is `details:{kind:"rate_limit", providerErrorType:"rate_limit_error", status:429, requestId, retryAfterMs}`. There are three `auto_retry_start` events (`attempt` 1–3, `delayMs` = `retry-after` when sent, else about 2 s, 4 s, 8 s), then `auto_retry_end {success:false, attempt:3}` and `provider_retry_outcome` "Retry failed after 3 attempts". `prompt_and_wait` then fails with that text, the session is idle, and `isQuotaParked` is false. With `retry-after: 30` the whole turn takes about 93 s.
- The adapter's stdout parser sees these as JSON events; today they surface as `prime_run_failed`.

### 15. Self-registration reaches the host's `select()`

**Yes** (e16, one Node process, live paths). The host server resolves `@paperclipai/shared` to `…/app/packages/shared/dist/index.js`. The adapter side, through a `node_modules/@paperclipai/shared` link to `…/app/packages/shared`, resolves `@paperclipai/shared/ai-connections` to `…/app/packages/shared/dist/ai-connections.js`. Both give the **same** `AI_CONNECTION_CAPABILITIES` object.

Before the push, the host's `isAiConnectionCompatible({anthropic, subscription, responsible_user}, "prime_agent_local", …)` was false. After the adapter side pushed `"prime_agent_local"` into `anthropic.methods.subscription.adapters`, it was true. The `api_key` array stayed `["claude_local"]`, and an `api_key`-only requirement stayed false. `isAiConnectionCompatible` is the gate that `select()` calls (`server/dist/services/ai-connections.js:117-120`). For `responsible_user` it accepts any method whose array holds the type.

### 16. Rev 5: skill discovery off, the skill list of children, the default built-ins, prompt templates (2.2 items 9 and 10)

Added for plan rev 5 (e24–e27). Each session had a skill in every found place: `<agentDir>/skills/<dir>/SKILL.md`, a loose `<agentDir>/skills/x.md`, `<cwd>/.prime/agent/skills/`, `<cwd>/.agents/skills/`, a `.agents/skills/` two dirs above `cwd`, `$HOME/.agents/skills/` and a path in `settings.json` `skills`. One more skill was passed by path in the create config's `skills`. The skill list was read from `<available_skills>` in each session's first model request, and checked against `get_resource_snapshot` (the two always matched). **Resources load lazily:** the snapshot is empty until a command such as `get_commands` or a prompt has run.

**There is no daemon `create` field that turns skill discovery off** (e24, e25, e26).
- `noSkills: true` in the create config is accepted (`success:true`) and ignored. All seven found skills still loaded in the parent, the depth-1 child and the `create_session` session (e24).
- So is every other name I tried (e26): `noSkills`, `noPromptTemplates`, `noThemes`, `skillDiscovery: false|"off"`, `discoverSkills`, `disableSkillDiscovery`, `noSkillDiscovery`, `includeDefaultSkills`, `enableBuiltinSkills`, `builtinSkills`, `discovery`, `noDiscovery`, `resources: {…}`, `resourceSelection`, a nested `settings` object, and `executionMode: "headless"` with `noSkills`. Each one left the skill, prompt and context file counts unchanged. Unknown create config keys are ignored silently, so a list of names cannot prove a negative. But the CLI's own daemon client sends none either: under a pseudo-terminal, `prime-agent --no-skills --no-prompt-templates --no-context-files` sent `create` with `config: {cwd, executionMode:"interactive", sessionDir, provider, model, telemetryDisabled}` and nothing more (e25). The print, `json` and `rpc` modes never open the daemon socket.
- **`noContextFiles: true` in the create config is ignored too** (e26). The adapter sends it today when `noContextFiles` is set (`execute-daemon.ts:403`). In 0.10.1 daemon mode, `cwd`'s `AGENTS.md` still loads with it.

**`settings.json` can do it instead** (e27, e24):
- `enableBuiltinSkills: false` (agent-dir settings) drops all 12 built-ins and nothing else.
- `skills: ["!**"]` in the **agent dir's** `settings.json` drops every user-scope found skill: `<agentDir>/skills/` (the loose `.md` too), `$HOME/.agents/skills/` and the built-ins. `"!**/*"` and `"!*"` act the same. **Project-scope skills stay**: `<cwd>/.prime/agent/skills/`, `<cwd>/.agents/skills/` and the parent `.agents/skills/` (e24, `source: auto`, `scope: project`).
- With `skills: ["!**"]` in **both** the agent dir's and `<cwd>/.prime/agent/settings.json`, only the create config's `skills` list loaded: the staged skill and every built-in passed by path as `<release>/skills/<name>`. That held in the parent, the depth-1 child and the `create_session` session. No found skill's text was anywhere in their requests (e24).
- `enableSkillCommands: false` changed nothing in the skill list.
- Not tested: whether a `!` pattern in the project file alone, without the agent-dir one, also drops user-scope skills; and a `.gitignore`-style ignore file in a skills dir (the 0.8 TS source reads them).

**Children and `create_session` sessions get the parent's skill list.** In all four e24 runs (default, `noSkills`, agent-dir exclude, both excludes), the depth-1 child's and the `create_session` session's `<available_skills>` equalled the parent's, name for name.

**The built-ins a default 0.10.1 daemon session loads** (no websearch key, no MCP login, factory off; e12, e24, e26): `agent-message`, `agent-observe`, `attach-image`, `compact`, `edit`, `goal`, `mcp`, `prime-intellect`, `refine`, `rlm-heartbeat`, `skill-creator`, `websearch`, which makes 12. `<release>/skills/factory/SKILL.md` does not load. The snapshot gives a warning for it, "description is required". Passing all of them by path reproduces the same 12 names, without `factory`.

**Prompt templates do not reach the model unless a user types them** (e24). Templates in `<agentDir>/prompts/` and `<cwd>/.prime/agent/prompts/` appear only in `get_commands` and in the snapshot. Neither their description nor their body was in any model request: system prompt, messages or tools. A child prompt written by the model, `rlm.spawn('/n0tmpl-agent')`, reached the child as `[task from parent]\n\n/n0tmpl-agent`, not expanded. The same text sent by the client with `prompt_and_wait` was expanded to the body. Not tested: text that starts with `/` in `agent_message.send`, in a heartbeat or schedule prompt, or in a goal objective.

**Parent-dir context files** are in item 9: `AGENTS.md`, or `CLAUDE.md` when that dir has no `AGENTS.md`, from every ancestor of `cwd` up to `/`, with no stop at a `.git` dir. For `.agents/skills/` I saw a parent two levels up load, with no git repo on the path. Where that walk stops when there is a git root was not tested.

**`<agentDir>/skills/` again:** in e24, Prime added nothing there; the dir held only the two staged entries at the end. Item 11 still holds.

### 17. Checkpoint addenda A and B (Axiom's `checkpoint` document, sections 7 and 9)

**A. Top-level agent-dir entries that Prime writes in a normal daemon run.** I listed the agent dir of both e10 adapter runs, and every N0 scratch agent dir (71 dirs). Prime wrote these entries that are not on Axiom's item 11 keep-list:
- `daemon-workers/` (every run): one dir per daemon, with each worker's `<id>.json`, `recovery.jsonl`, `orphans.jsonl`, writer locks and `supervisor-config`
- `logs/` (every run): the daemon socket log and each worker's `stderr.log`
- `session-leases/` (every run): session lease files, empty after a clean stop
- `rlm-ledger/` (runs that spawn a child; 15 of 71): one `<hash>.jsonl` per ledger

Also seen, but written by the test itself and not by Prime: `models.json` (N0's redirect to the fake server), `skills/`, `prompts/` and the context files. Prime also writes two catalog caches when its GitHub fetch succeeds (B below): `models/provider-model-catalog.v1.json` and `mcp-service-catalog.v2.json`. The host's own Prime dir has both. Under item 11 they would be moved like any other entry, and Prime fetches them again at the next start.

**B. The catalogs fetched from GitHub** (e28, e29; read-only GETs of the public files on 2026-10-25, then offline tests).
- `models/catalog.v1.json` (sha256 `f0572237…7bec9d`, 1,209 models): **every entry has a `baseUrl`**, and 255 have a `compat` object. One `compat` field is `sendSessionAffinityHeaders` (Cloudflare entries). The anthropic entries all have `baseUrl: "https://api.anthropic.com"`. No entry has a header, auth or key field.
- `plugins/catalog.v2.json` (sha256 `522afc14…5737c`, 69 entries): MCP services, each with an `https` `url`, `transport {type:"http", url}` and `auth {strategy, clientRegistration}`. No secrets.
- **Prime caches both in the agent dir**: `<agentDir>/models/provider-model-catalog.v1.json` and `<agentDir>/mcp-service-catalog.v2.json`, each `{url, scope, fetchedAt, etag, payload}`. A daemon start reads the cache when the fetch fails: with a seeded cache, `get_model_catalog` listed the catalog's 1,209-model set, not the bundled fixtures.
- **A catalog `baseUrl` did not redirect the anthropic provider** (e28, no `models.json`). In the cache, I changed `claude-opus-5-5`'s `baseUrl` to the fake server (`http://127.0.0.1:…`), to `https://n0-redirect.invalid` and to `https://api.anthropic.com/n0`. In all three runs, Prime **dropped that entry** from `get_model_catalog`. The turn went to the default endpoint (offline, so "Connection error."), and no request reached the fake server. A control that changed only the entry's `name` kept the entry with the new name. So for anthropic, the catalog can change model metadata (name, `reasoning`, thinking levels, limits, cost) but not the address, in these tests. Not tested: a catalog entry for a provider that has no built-in address, and a new provider name.
- **The plugins catalog loaded nothing** (e29). With a seeded plugins cache, the session's tools (`python_repl` only) and its system prompt were the same as without it, apart from the session paths. No MCP server was started and nothing was installed.

## New facts the plan does not have

1. **A daemon start reaches GitHub.** At daemon start, Prime opened 3 HTTPS connections to `raw.githubusercontent.com` (refused here). The binary names `PrimeIntellect-ai/prime-agent-catalog/main/models/catalog.v1.json` and a `plugins/catalog.v…` file. Offline, `anthropic/claude-opus-5-5` resolves as a model with `reasoning: false`, because the bundled `models.bundled.json` holds fixtures only. So the live model list, and Opus 5.5's thinking support, come from that fetch. `--offline` ("Disable startup network operations") exists; I did not test it in daemon mode.
2. **`telemetry.json`** (`installationId`) is written to the agent dir even with telemetry off.
3. **An `sk-ant-oat` key stored as `type:"api_key"` is sent as Claude Code** (e10, fake key). The request carries `Authorization: Bearer`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, `user-agent: claude-cli/2.1.281` and an `x-app` header, and the system prompt begins "You are Claude Code, Anthropic's official CLI for Claude." `auth.json` was not rewritten across two runs. This is section 7 item 3, shown offline; Anthropic's acceptance is still canary run 1.
4. **A woken child gets a new `activeSessionId`** and keeps its `sessionId` (items 3 and 4).
5. **`delete_rlm_subagent` refuses a running child** (item 3).
6. **The host refine store is not the kernel store** (item 8).
7. **Context files load from every ancestor of `cwd`** (item 9).

## N0 facts that contradict the plan

1. **2.2 item 2, ended-session identity.** The plan keys the cap and the "ended id seen running" check on `activeSessionId`. A killed or old child that is woken comes back under a new `activeSessionId` with the same `sessionId`. Keyed on `activeSessionId`, a woken session counts as new, and the wake check misses it. The key has to be `sessionId` (or the session file).
2. **2.2 item 2, the end command.** No single command ends both kinds, and `kill`, the plan's first example, does not block a wake of a depth-1 child. Depth ≥ 1 needs `cancel_rlm_child`, then `delete_rlm_subagent` (both with the parent's `activeSessionId` and `rlmChildId`), because a bare `delete_rlm_subagent` refuses a running child. Depth 0 needs `kill`.
3. **F7 and 2.2 items 3 and 8, the refine path.** F7 says `refine` with `global_=True` edits every later session. In 0.10.1 its global edits go to `<agentDir>/harness_state.json` and `<agentDir>/refinement_history.jsonl`, and the next new session did not see them. What reaches later sessions is the kernel store `<agentDir>/harness/harness_state.json`, through the `[harness-digest]` user message. So item 8's file is the kernel one. `harnessFingerprint`, `harnessBytes` and `refinementEvents` need these paths stated, and the refine-store files are a second place an agent's edits can land.
4. **2.2 item 6, 2.4 and section 7 item 14, workspace context files.** The plan's known exception is `cwd`'s own `AGENTS.md` and `CLAUDE.md`. Prime also loads `AGENTS.md`, or `CLAUDE.md` when there is no `AGENTS.md`, from **every ancestor of `cwd`** up to `/`. An agent that writes one in a parent dir (for example `…/instances/default/workspaces/AGENTS.md`) changes the next run's prompt for every agent whose workspace is below it, and the `cwd`-only hashes would not see it. None exist today.
5. **2.2 item 1, the `retry` value.** The plan wants Prime's default `retry` with `waitForUsage` neither waiting nor parking. I could not make Prime park on any fake 429, with or without `waitForUsage.enabled/pauseUntilReset`, and the binary does not give the 8 `waitForUsage` field names with certainty. What is shown: a partial `retry` object keeps the other defaults, and by default a 429 fails the turn after 3 retries. The exact managed `retry` value needs Axiom's call.
6. **2.2 item 1, `autoRefine`.** The plan says autoRefine runs a review every N assistant turns. I could not make 0.10.1 run one offline. That is not proof that it never runs, so `autoRefine:{enabled:false}` stays the safe value, but its effect is `unverified`.
7. **2.2 item 10, the discovery-off field (rev 5).** The daemon `create` config has no `noSkills` or any other field that turns discovery off; `noSkills: true` is ignored (item 16). By the plan's text, that selects item 10's fallback. But `settings.json` can do the same job: `skills: ["!**"]` in the agent dir's file and in `<cwd>/.prime/agent/settings.json`, and the explicit `skills` list still loads, in children too. The agent-dir file is the adapter's own (2.2 item 5). The project file sits inside `<cwd>/.prime/agent/`, which item 6 moves aside every run, so the adapter would have to write it after the move. Which branch to take is Axiom's call.
8. **2.2 item 6 and the existing `noContextFiles` option.** In 0.10.1 daemon mode, `noContextFiles: true` in the create config is ignored, and `AGENTS.md` still loads (item 16). The plan relies on it in no `governed-v1` path. But the adapter's current `noContextFiles` option does nothing under `runtime: "daemon"`, and option (b) in the checkpoint's contradiction 4 ("force `noContextFiles`") would not work as a create field.

## What N0 settles for the checkpoint branches

| Plan item | N0 result |
|---|---|
| 2.2 item 2, end command | depth ≥ 1: `cancel_rlm_child` + `delete_rlm_subagent`; depth 0: `kill`. Both block a later wake. |
| 2.2 item 2, poll or subscription | `roster_subscribe` delivers `roster_update` during a turn. |
| 2.2 item 7 | `create` with `sessionPath` started no turn, and `/goal clear` clears from outside the model, so the `cleared` branch is available. |
| 2.2 item 8 | non-memory global kinds (`prompt`, `skill`, `subagent`) reach later sessions, so the strip branch applies. |
| 2.2 item 9, exemptions | Prime wrote nothing under `<agentDir>/skills/` in any run (items 11 and 16). No name needs an exemption. Sentinel accepted item 9 (TAI-322, rev 5). |
| 2.2 item 10 | No `create` field turns discovery off. `settings.json` `skills: ["!**"]`, in the agent dir and in the project, does, and the explicit list still loads. Children and `create_session` sessions get the parent's list. The default built-in allowlist is the 12 names in item 16. Prompt templates do not reach the model untyped, so `noPromptTemplates` is not needed (and there is no create field for it either). |
| F14 and 2.3 kernel keys | all three honoured; reuse with no download; the interpreter is under `prime-kernel/python`. |
| 4.3 item 5 | workers lead their own process group. |

## Still unverified after N0

- whether `waitForUsage` parks by default on a real Anthropic usage-limit 429, and the field that turns it off
- whether `autoRefine` runs in 0.10.1 daemon mode at all, and when
- the completeness of the settings key list (Prime ignores unknown and bad keys silently)
- clearing a `paused` goal with `/goal clear`
- whether the session that ran `refine.run(global_=True)` sees its own edit
- the effect of `--offline` in daemon mode on the catalog fetch and the model list
- that no daemon `create` field turns discovery off (only the names in item 16 were tried; unknown keys are ignored silently)
- whether a project-file `!` pattern alone also drops user-scope skills, and ignore files in skills dirs
- where the `.agents/skills/` walk stops at a git root
- whether text that starts with `/` in `agent_message.send`, a heartbeat, a schedule or a goal objective expands a prompt template
