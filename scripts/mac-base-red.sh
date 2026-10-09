#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# scripts/mac-base-red.sh <base> <report>: after a red run of ci's macOS tests, whether the change made it red. The
# files that failed run again on <base>, built in a worktree of its own, and the run passes only when every failing
# test fails there too: main is red on a Mac, which no Linux job sees, and the change is not to blame. Exits 1 when a
# failure is new, or when there is no base to read it against.
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: scripts/mac-base-red.sh <base> <vitest json report>" >&2; exit 3; }
base=$1 report=$2
# Both read with symlinks resolved, as vitest names its files: a Mac's temporary folders sit under /var, a link.
root=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
work=$(cd "$(mktemp -d)" && pwd -P)

# One line per failing test, "<file> > <name>", and the file alone for a file that failed before any test ran.
failed() {
  jq -r --arg top "$1/" '.testResults[] | select(.status == "failed") | (.name | ltrimstr($top)) as $file
    | ([.assertionResults[] | select(.status == "failed") | "\($file) > \(.fullName)"] | if length == 0 then [$file] else . end)[]' "$2" | sort -u
}
failed "$root" "$report" > "$work/head"
if [ ! -s "$work/head" ]; then echo "::error::the Mac tests failed and the report names no failing test"; exit 1; fi
if [ -z "$base" ]; then echo "::error::the Mac tests failed: $(tr '\n' ';' < "$work/head")"; exit 1; fi

files=$(sed 's/ > .*//' "$work/head" | sort -u | while IFS= read -r file; do [ -z "$(git ls-tree "$base" -- "$file")" ] || echo "$file"; done)
if [ -z "$files" ]; then echo "::error::the Mac tests failed, in files main does not have: $(tr '\n' ';' < "$work/head")"; exit 1; fi

echo "Running the failing files on $base: $(echo $files)"
git worktree add --detach "$work/tree" "$base"
cd "$work/tree"
pnpm install --frozen-lockfile --prefer-offline
# The base's own daemon, built in the change's target folder, whose crates it shares.
if [ "$(git rev-parse "$base:daemon")" != "$(git -C "$root" rev-parse HEAD:daemon)" ]; then
  (cd daemon && CARGO_TARGET_DIR="$root/daemon/target" cargo build --locked -p wsp-daemon-bin $(node ../packages/wspx/scripts/daemon-features.mjs))
fi
node packages/wspx/scripts/daemon-binary.mjs --from "$root/daemon/target/debug/wsp-daemon"
pnpm -r --filter '!./apps/www' --filter '!./apps/docs' --filter '!@wsp/desktop' build
export WSP_MCP_BIN=$root/daemon/target/debug/wsp-daemon
pnpm exec vitest run --minWorkers=1 --maxWorkers=3 --reporter=default --reporter=json --outputFile.json="$work/base.json" $files || true
failed "$PWD" "$work/base.json" > "$work/base-failed"

new=$(grep -vxF -f "$work/base-failed" "$work/head" || true)
if [ -n "$new" ]; then echo "::error::new on this change, passing on main: $(tr '\n' ';' <<< "$new")"; exit 1; fi
echo "::warning::main $base is red on a Mac too, so the change passes: $(tr '\n' ';' < "$work/head")"
