#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Runs a command, and on a Mac first waits for one of two slots under /tmp, so
# builders working at once queue their typechecks, builds and test runs: seven
# at once swapped 14 GB on the owner's Mac. A slot whose holder has exited is
# taken over. A command already inside a slot runs its own heavy steps in that
# slot, so a nested call never waits on the slot it holds.
set -u

if [ $# -eq 0 ]; then
  echo "refused: name the command to run; usage: scripts/heavy.sh <command>..." >&2
  exit 2
fi
if [ "$(uname)" != Darwin ] || [ -n "${WSP_HEAVY_SLOT:-}" ]; then
  exec "$@"
fi

held=""
trap '[ -n "$held" ] && rm -rf "$held"' EXIT
trap 'exit 130' INT TERM
while [ -z "$held" ]; do
  for slot in /tmp/wsp-heavy-slot-1 /tmp/wsp-heavy-slot-2; do
    if mkdir "$slot" 2>/dev/null; then
      echo $$ >"$slot/pid"
      held=$slot
      break
    fi
    holder=$(cat "$slot/pid" 2>/dev/null)
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$slot"; fi
  done
  [ -n "$held" ] || sleep 2
done
WSP_HEAVY_SLOT=$held "$@"
