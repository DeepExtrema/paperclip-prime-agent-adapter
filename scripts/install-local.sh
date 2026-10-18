#!/usr/bin/env bash
# Registers this checkout with a running Paperclip as the local-path adapter plugin prime_agent_local.
set -euo pipefail

usage() {
  echo "usage: scripts/install-local.sh --api-url <http://host:port/api> [--skip-build]" >&2
  exit 2
}

api_url=""
skip_build=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --api-url) [ "$#" -ge 2 ] || usage; api_url="$2"; shift 2 ;;
    --skip-build) skip_build=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$api_url" ] || usage
api_url="${api_url%/}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 11)) { console.error(`node ${process.versions.node} is older than 24.11.0`); process.exit(3); }'
if [ "$skip_build" -eq 0 ]; then
  (cd "$repo_root" && npm ci && npm run build)
fi
if [ ! -f "$repo_root/dist/index.js" ]; then
  echo "missing $repo_root/dist/index.js; run npm run build" >&2
  exit 3
fi

auth=()
body="$(node -e 'process.stdout.write(JSON.stringify({ packageName: process.argv[1], isLocalPath: true }))' "$repo_root")"
curl -sS -o /dev/null -X POST "$api_url/adapters/install" -H 'Content-Type: application/json' "${auth[@]}" -d "$body"
curl -sS -o /dev/null "${auth[@]}" "$api_url/adapters/prime_agent_local"
echo "prime_agent_local registered from $repo_root (loaded, external)"
