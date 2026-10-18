# Install

Register this checkout as a local-path adapter plugin.

## Prerequisites

- Paperclip 2026.1005.0, with host `@paperclipai/adapter-utils` 0.3.1 under `$HOME/.paperclip/cli/installs/local/<version>/app/packages/adapter-utils`. `scripts/link-adapter-utils.mjs` holds the default path.
- Node.js 24.11.0 or newer.
- `prime-agent` 0.10.x runnable by the Paperclip server user.
- A Prime credential: a `prime-agent` login in `~/.prime/agent/auth.json`, or a provider API key.
- The server user can run `prime-agent --version` and it prints `0.10.x`.

## Build

```sh
npm ci
npm run build
```

`npm ci` runs `scripts/link-adapter-utils.mjs`. It links `node_modules/@paperclipai/adapter-utils` to the host copy and fails unless that copy is version 0.3.1. Set `PAPERCLIP_ADAPTER_UTILS_DIR` to use another host path. Paperclip imports `dist/index.js` from the checkout in place. Rebuild after every change.

## Register with the API

```sh
scripts/install-local.sh --api-url http://127.0.0.1:3100/api
```

Add `--skip-build` when `dist/` is fresh. The script checks Node ≥ 24.11.0 and runs `npm ci && npm run build` unless `--skip-build` is set. It sends `POST /api/adapters/install` with `{"packageName": "<absolute checkout path>", "isLocalPath": true}`. It then requires `GET /api/adapters/prime_agent_local` to return `"loaded": true` and `"source": "external"`.

Exit codes: 2 usage; 3 Node too old or `dist/index.js` missing; 4 install refused (prints the HTTP status); 5 not loaded.

The route needs an instance admin. In `local_trusted` mode a loopback caller is one. In authenticated mode export `PAPERCLIP_BOARD_TOKEN`; it is sent as `Authorization: Bearer`.

Equivalent curl:

```sh
curl -sS -X POST http://127.0.0.1:3100/api/adapters/install \
  -H 'Content-Type: application/json' \
  -d '{"packageName": "'"$PWD"'", "isLocalPath": true}'
```

Paperclip's own `docs/adapters/external-adapters.md` shows `POST /api/adapters` with `localPath`. The 2026.1005.0 server serves `POST /api/adapters/install` with `isLocalPath` (server `routes/adapters.ts`).

## Register through adapter-plugins.json

With Paperclip stopped, edit `$PAPERCLIP_HOME/adapter-plugins.json` (default `~/.paperclip/adapter-plugins.json`). Keep existing entries and append this record, replacing the path. Start Paperclip; the file is read at startup.

```json
{
  "packageName": "/absolute/path/to/paperclip-prime-local-adapter",
  "localPath": "/absolute/path/to/paperclip-prime-local-adapter",
  "version": "0.1.0",
  "type": "prime_agent_local",
  "installedAt": "2026-10-18T00:00:00.000Z"
}
```

## Update, reload, remove

After `npm run build`, send `POST /api/adapters/prime_agent_local/reload` or restart Paperclip. Remove with `DELETE /api/adapters/prime_agent_local`.

## Create an agent

Send `POST /api/companies/{companyId}/agents` with:

```json
{
  "name": "Prime Engineer",
  "role": "engineer",
  "adapterType": "prime_agent_local",
  "adapterConfig": { "model": "anthropic/claude-haiku-4-5", "thinking": "off" },
  "runtimeConfig": { "heartbeat": { "maxConcurrentRuns": 1 } }
}
```

If the company has `requireBoardApprovalForNewAgents`, hire through `POST /api/companies/{companyId}/agent-hires` with the same body instead. Never bypass approval.

## What installation does not change

Registering the plugin or selecting `prime_agent_local` on one agent changes no company default, no other agent's `adapterType` or `model`, and no hire policy (L15). The WP7 smoke checks that the company record and a control agent created before the install are unchanged (`adapterType`, `adapterConfig`).

## Try it in a throwaway Paperclip

This smoke makes real model calls. Get the owner's approval first.

```sh
node scripts/smoke-throwaway-paperclip.mjs --root /var/tmp/prime-local-smoke/attempt-1 \
  --paperclip-cli "$HOME/.paperclip/cli/current/node_modules/paperclipai/dist/index.js" \
  --node-bin-dir "$(dirname "$(command -v node)")" \
  --prime-command "$HOME/.local/bin/prime-agent" \
  --host-auth-file "$HOME/.prime/agent/auth.json"
```

It does exactly this:

1. Refuses a root outside `/tmp/` or `/var/tmp/`, an existing root, or busy ports 3197/54397.
2. Builds a child environment from an allowlist only (`HOME`, `TMPDIR`, `XDG_*`, `npm_config_cache`, `UV_CACHE_DIR`, `PAPERCLIP_HOME`, `PAPERCLIP_INSTANCE_ID=wp7smoke`, `PATH`, `LANG`, two browser switches), with every path under the root. It self-tests that `os.homedir()` and `os.tmpdir()` resolve under it.
3. Writes `<root>/paperclip-home/instances/wp7smoke/config.json` before the first start: `local_trusted`, loopback, server port 3197, embedded Postgres port 54397, UI and backups off. The quickstart default port 54329 would make the server connect to the live instance's Postgres.
4. Links `.prime/agent/auth.json` inside the throwaway home (`<root>/home`) to the host Prime auth file.
5. Starts `paperclipai run -i wp7smoke` from the installed app tree, which is only read.
6. Creates a company and a `process` control agent.
7. Registers this checkout with `scripts/install-local.sh` and checks that the company record and the control agent are unchanged.
8. Creates two `prime_agent_local` agents (`anthropic/claude-haiku-4-5`, thinking off, `maxConcurrentRuns: 1`). It runs the three scenarios and writes evidence to `<root>/evidence/`: `SUMMARY.json` plus run, log, usage, session and process files.
9. Stops the server with SIGTERM to its process group. It checks that ports, processes and the live state (metadata only) are unchanged.
