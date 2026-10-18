# Prime Agent adapter for Paperclip

`@deepextrema/paperclip-prime-local-adapter` is an external Paperclip adapter plugin. It adds the adapter type `prime_agent_local` (label "Prime Agent"). Each heartbeat runs stock `prime-agent` 0.10.x locally with `--mode json -p`, the way the built-in `pi_local` adapter runs Pi. The type is not `prime_local`, because a third-party adapter already uses that key.

## What it does

- Works for coordinators and specialists, with or without an issue.
- Each agent has its own Prime directory under the Paperclip company tree (settings, memories, sessions).
- Sessions resume per Paperclip task session when cwd, model and agent dir still match.
- Paperclip skills are passed with `--skill` for one run.
- The instructions bundle is appended with `--append-system-prompt`.
- The model list comes from `prime-agent model list`.
- The environment test makes no model call.
- Run logs render through the adapter's UI parser.

## Requirements

- Paperclip 2026.1005.0, with host `@paperclipai/adapter-utils` 0.3.1 under `$HOME/.paperclip/cli/installs/local/<version>/app/packages/adapter-utils`. `scripts/link-adapter-utils.mjs` holds the default path.
- Node.js 24.11.0 or newer.
- `prime-agent` 0.10.x runnable by the Paperclip server user.
- A Prime credential: a `prime-agent` login in `~/.prime/agent/auth.json`, or a provider API key.

## Quick start

```sh
npm ci
npm run build
scripts/install-local.sh --api-url http://127.0.0.1:3100/api
```

The agent's `model` must be a `provider/modelId` value listed by `prime-agent model list`.

## Documentation

- [Install](docs/install.md)
- [Configuration](docs/configuration.md)
- [Credentials](docs/credentials.md)
- [Troubleshooting](docs/troubleshooting.md)

## Security

- No containment: Prime runs as the Paperclip server user and the agent runs model-chosen code. A prompt is not a sandbox.
- With `credentialMode: "host_auth"` the agent can read the host Prime subscription token through its own `auth.json` link.
- The agent's environment holds a short-lived `PAPERCLIP_API_KEY`.
- Use `credentialMode: "api_key"` with a dedicated key when isolation matters.

## Qualification

Claim levels: registered/loaded, deterministic-qualified, live-qualified; anything else is not qualified.

| Surface | Claim level | Evidence |
|---|---|---|
| Plugin shape expected by Paperclip's loader (`createServerAdapter`) | deterministic-qualified | `test/contract.test.ts` |
| Plugin registered and loaded by Paperclip 2026.1005.0 (POST /api/adapters/install, throwaway instance) | registered/loaded | WP7 smoke check "adapter loaded from external plugin" |
| Symlinked staged skill directory (`--skill`) | not qualified | PARTIAL: --skill with a symlinked staged dir accepted by prime-agent 0.10.0; skill loading by the model not observed. Specialist run argv and success recorded in WP7 smoke. |
| Config, credentials, env hygiene, argv, JSONL parsing, session codec, skills, models, environment test, UI parser | deterministic-qualified | unit tests in `test/` against captured prime-agent 0.10.0 output |
| Coordinator wake without an issue, specialist wake on the created issue, two agents at once on one symlinked subscription (throwaway Paperclip 2026.1005.0, prime-agent 0.10.0, anthropic/claude-haiku-4-5, thinking off, 2026-10-18) | live-qualified | WP7 smoke attempt-1 and attempt-2 (after F1): every run, concurrency, cleanup and live-state check passed both times (23 of 24 checks; the one failure is the model-list row below). |
| Host model list (`listModels()` without agent context) | not qualified | The smoke check `model list includes the smoke model` failed in both attempts and cannot pass inside this harness: `listModels()` uses the server `HOME`, which the smoke points at an empty throwaway home (no user-local `prime-agent`, no `auth.json`). Under the live service environment (real user home, service `PATH` without the user-local bin) the F1 fallback resolved the user-local `prime-agent` and the built `listPrimeModelsForAdapter()` returned 275 models including the smoke model (direct call, 2026-10-18). A model-list check on the live host is part of the WP8 cutover. |

## License

MIT, see `LICENSE`. The structure follows Paperclip's MIT-licensed `pi-local` adapter.
