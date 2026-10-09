#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# scripts/mac-gate.sh <base> <list>: what ci's macOS job runs for the change from <base> to HEAD, with no base the
# whole of it. Prints run=0|1 and daemon=0|1 for $GITHUB_OUTPUT, writes the vitest filters to <list>, and why to
# stderr. The Linux jobs run the whole change; this job runs only what can differ on a Mac: the daemon's Mac build,
# its lints and tests when daemon/ changed, and the test files below.
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: scripts/mac-gate.sh <base>|'' <list>" >&2; exit 3; }
base=$1 list=$2
cd "$(git rev-parse --show-toplevel)"

# The files only a Mac runs, less the docs and the daemon's records and fixtures under them.
MAC_PATHS='^(apps/desktop/|daemon/|packages/host/src/(places/[^/]+|places|place-[a-z-]+|service)\.ts$|packages/catalog/src/signin\.ts$|packages/collect/src/detect/logins\.ts$)'
# A change to this job runs the whole of it, so the job is proved on the change that edits it.
OWN='^(\.github/workflows/ci\.yml|scripts/mac-(gate|base-red)\.sh)$'

# Every desktop test and every test that branches on the platform, read fresh from the tree so a new one joins.
platform() {
  {
    git ls-files ':(glob)apps/desktop/test/*.test.*'
    git ls-files ':(glob)apps/**/*.test.ts' ':(glob)apps/**/*.test.tsx' ':(glob)packages/**/*.test.ts' ':(glob)packages/**/*.test.tsx' \
      | xargs grep -lE "darwin|launchctl|codesign|\.app/Contents|process\.platform"
  } | sort -u > "$list"
}

if [ -z "$base" ]; then
  echo "no base: the daemon and every platform test" >&2
  platform; echo run=1; echo daemon=1; exit 0
fi
changed=$(git diff --name-only --no-renames "$base" HEAD)
if grep -qE "$OWN" <<< "$changed"; then
  echo "the change edits this job: the daemon and every platform test" >&2
  platform; echo run=1; echo daemon=1; exit 0
fi
mac=$(grep -E "$MAC_PATHS" <<< "$changed" | grep -vE '\.md$|^daemon/(.*/)?(record|fixtures)/' || true)
if [ -z "$mac" ]; then
  echo "skipped: the change touches nothing only a Mac runs" >&2
  : > "$list"; echo run=0; echo daemon=0; exit 0
fi
daemon=0; grep -q '^daemon/' <<< "$mac" && daemon=1
# affected-tests.mjs maps daemon/ to every package that runs the binary, the node suite the Linux jobs ran.
if ! grep -qv '^daemon/' <<< "$mac"; then
  echo "daemon files alone: the daemon and every platform test" >&2
  platform; echo run=1; echo daemon=$daemon; exit 0
fi
# The script reads the change from its base to HEAD, so its base here is HEAD with the Mac files put back as <base>
# had them: the diff it reads is the Mac files alone.
index=$(mktemp); trap 'rm -f "$index"' EXIT
export GIT_INDEX_FILE=$index
git read-tree HEAD
while IFS= read -r file; do
  entry=$(git ls-tree "$base" -- "$file")
  if [ -n "$entry" ]; then git update-index --index-info <<< "$entry"; else git update-index --force-remove -- "$file"; fi
done <<< "$mac"
macbase=$(GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@localhost GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@localhost git commit-tree "$(git write-tree)" -p HEAD -m "the change less its Mac files")
unset GIT_INDEX_FILE
node scripts/affected-tests.mjs "$macbase" > "$list"
if [ -s "$list" ]; then echo "$(wc -l < "$list" | tr -d ' ') filters from scripts/affected-tests.mjs for the Mac files" >&2
else echo "scripts/affected-tests.mjs named no list for the Mac files: every platform test" >&2; platform; fi
echo run=1; echo daemon=$daemon
