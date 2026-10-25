#!/bin/sh
# N0: run a command in a private network namespace with loopback only, as the calling user.
# Nothing inside can reach Anthropic or any other host; the fake server listens on 127.0.0.1 inside the same namespace.
set -eu
exec unshare -rn sh -c 'u=$0; g=$1; shift; ip link set lo up && exec unshare --map-user="$u" --map-group="$g" -U "$@"' "$(id -u)" "$(id -g)" "$@"
