# Test fixtures

Real output of stock `prime-agent` 0.10.0 on this host. Nothing here was produced by the adapter. No model was called to make the WP0 files; `run1`-`run4` come from the CHECK runs of 2026-10-17 (`/tmp/prime-local-check-we2ejug3`), copied byte for byte. `/tmp` paths and session ids are left as captured. The exact argv of the CHECK runs was not stored with the files; the notes below infer it from the content.

## `prime-jsonl/` — `prime-agent --mode json -p` stdout

| File | Shows |
|---|---|
| `run1.jsonl` | Provider failure with exit 0. No `--provider`/`--model` and an empty agent dir, so Prime used its Bedrock placeholder (`amazon-bedrock` / `fixture-amazon-bedrock-0`). Assistant `stopReason: "error"`, `errorMessage: "No AWS credentials available for Bedrock"` in `message_end`, `turn_end` and `agent_end`; all usage 0. Session `01a14c2a-05ac-7659-a080-adb0fb06fb08`. |
| `run1.stderr.txt` | Stderr of run1: Prime's first-run telemetry notice (telemetry was not disabled for that run). The other runs had empty stderr. |
| `run2.jsonl` | Plain success: `anthropic` / `claude-haiku-4-5` (host subscription), one turn, answer `OK`. Usage input 3, output 4, cacheWrite 10553, cost 0 (subscription). Shows `message_update` text deltas and the `custom` `harness_digest` message (`display: false`). New session `01a14c2a-5965-7269-8920-97d0da73b791`, file `<session-dir>/<id>.jsonl`. |
| `run3.jsonl` | Resume of run2's session (`-r <session file>`): same session id and header timestamp, no `harness_digest`, answer `PELICAN` (recalls run2). Usage covers only this run (input 3, output 6, cacheRead 10553), so usage is per run, not cumulative. |
| `run4.jsonl` | Three turns, two `ipython` tool calls (`stopReason: "toolUse"`), `tool_execution_start`/`tool_execution_end` (result object `{content, details}`), `turn_end.toolResults`, `toolResult`-role messages, and a skill loaded with `--skill` from `<tmp>/skills/paperclip-check/SKILL.md`. Final answer `**42 HERON-42**`. Session `01a14c2a-a744-70f9-bdde-4882ae3a009c`. |

sha256 (pinned by `test/contract.test.ts`):

```
d3694d77ebc3fbce998918c0f0b52f920021461030249a4113e7d604faecb1ce  prime-jsonl/run1.jsonl
c95fdf9376b4f7d8358b0850c82b65f2568f872958f2e2a38375b87cc1cfd265  prime-jsonl/run2.jsonl
059cc2e8a469980178b6ffe0d49338aef7f5008e156fd3ce999df97ca3daf00b  prime-jsonl/run3.jsonl
76ad44f21cfad2a9927987bc43fbe7778d665ea76dcf12a0d68b8033241e68e8  prime-jsonl/run4.jsonl
```

## Top-level files (WP0, 2026-10-18)

All captured with `env -i HOME=$HOME PATH=... PRIME_AGENT_TELEMETRY=0 PRIME_AGENT_CODING_AGENT_DIR=<scratch dir>`; never with the host `~/.prime/agent` as agent dir (`model list` writes `auth.json` and `models/` into the agent dir).

| File | Command | Agent dir credential |
|---|---|---|
| `version.txt` | `prime-agent --version` | empty dir |
| `help.txt` | `prime-agent --help` | empty dir |
| `model-list.txt` | `prime-agent model list` | `auth.json` symlinked to the host `~/.prime/agent/auth.json` (anthropic 16, openai-codex 17, vercel-ai-gateway 242 rows). The host file's size, mtime and inode were unchanged afterwards. |
| `model-list-api-key-anthropic.txt` | `prime-agent model list` | per-agent `auth.json` = `{"anthropic":{"type":"api_key","key":"<fake>"}}` (mode 0600): 16 anthropic rows, so Prime accepts this file shape. Note the narrower columns. |
| `model-list-no-auth.txt` | `prime-agent model list` | empty dir: "No models available" message, exit 0. Redacted: the home directory in the two doc paths is replaced by `/home/user` (L13). |
