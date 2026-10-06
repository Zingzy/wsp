#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Runs the named test files, and the two every run carries, at two workers. A
# path vitest is handed is a filter, and no path at all is the whole suite, so
# anything that is not a file is refused before vitest sees it.
set -u

usage='usage: scripts/test-files.sh [--tools] <test file>...'
root=$(git rev-parse --show-toplevel) && root=$(cd "$root" && pwd -P) || exit 2
always=(packages/host/test/memory.test.ts packages/protocol/test/stub-script.test.ts)
record=packages/host/test/mcp-record.test.ts

tools=0
named=()
for arg in "$@"; do
  case "$arg" in
    --tools) tools=1; continue ;;
    -h|--help) echo "$usage"; exit 0 ;;
    -*) echo "refused: $arg is not a flag this script takes; $usage" >&2; exit 2 ;;
  esac
  if [ -d "$arg" ]; then
    echo "refused: $arg is a folder, which runs every test under it; name the files" >&2
    exit 2
  fi
  if [ ! -f "$arg" ]; then
    echo "refused: $arg is not a file; vitest would read it as a filter and may run far more than it names" >&2
    exit 2
  fi
  # Both sides resolved, since a folder reached through a link (/tmp on a Mac) names the checkout differently.
  path=$(cd "$(dirname "$arg")" && pwd -P)/$(basename "$arg")
  case "$path" in
    "$root"/*) named+=("${path#"$root"/}") ;;
    *) echo "refused: $arg is outside this checkout ($root)" >&2; exit 2 ;;
  esac
done

if [ ${#named[@]} -eq 0 ]; then
  echo "refused: no test files named, and vitest with none runs the whole suite; $usage" >&2
  exit 2
fi

files=("${named[@]}" "${always[@]}")
[ $tools -eq 1 ] && files+=("$record")

if [ $tools -eq 0 ] && base=$(git -C "$root" merge-base origin/main HEAD 2>/dev/null); then
  # What the tool record is regenerated from: the host's sources, the catalog and protocol shapes its answers embed,
  # the skill its instructions are cut from, and the record itself.
  shaped=$(git -C "$root" diff --name-only "$base" -- packages/host/src packages/catalog/src packages/protocol/src skills/wsp/SKILL.md daemon/crates/wsp-mcp | head -n 1)
  if [ -n "$shaped" ]; then
    echo "note: this branch changes $shaped, which can move what the tools list or answer; run again with --tools to check $record" >&2
  fi
fi

unique=()
for f in "${files[@]}"; do
  seen=0
  for u in ${unique[@]+"${unique[@]}"}; do [ "$u" = "$f" ] && seen=1; done
  [ $seen -eq 0 ] && unique+=("$f")
done

cd "$root" && exec scripts/heavy.sh pnpm exec vitest run --minWorkers=1 --maxWorkers=2 "${unique[@]}"
