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
| Config, credentials, env hygiene, argv, JSONL parsing, session codec, skills, models, environment test, UI parser | deterministic-qualified | unit tests in `test/` against captured prime-agent 0.10.0 output |
| Coordinator wake, issue wake and two concurrent agents in a throwaway Paperclip | not qualified | pending the WP7 smoke |

## License

MIT, see `LICENSE`. The structure follows Paperclip's MIT-licensed `pi-local` adapter.
