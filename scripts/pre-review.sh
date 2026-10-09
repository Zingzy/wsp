#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# What a review keeps finding on a branch, checked before anyone says it is
# ready. Each check prints PASS, FAIL, WARN or SKIP with its reason, every
# check runs even after one fails, and any FAIL exits 1. The test files the
# branch changes run, then the ones its change reaches through imports. --laws
# runs only the laws and the size check, on the branch merged with
# origin/main, and --build builds the packages they load first. A ticket
# number prints the lines a report on it has to answer.
set -u

usage='usage: scripts/pre-review.sh [--laws] [--build] [<ticket number>]'
tickets=wsp-labs/wsp-map
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2

laws_only=0
build=0
ticket=""
for arg in "$@"; do
  case "$arg" in
    --laws) laws_only=1 ;;
    --build) build=1 ;;
    -h|--help) echo "$usage"; exit 0 ;;
    *[!0-9]*|"") echo "refused: $arg is neither a flag this script takes nor a ticket number; $usage" >&2; exit 2 ;;
    *) ticket=$arg ;;
  esac
done

# The tests that read the whole tree rather than the code beside them, so a change anywhere can turn them red. The
# landing runs this list on the squash, so it is the one list: packages/protocol/test/law-list.test.ts holds it to
# every law. test-files.sh adds the memory, stub-script and, under --tools, mcp-record tests to these.
LAWS=(
  packages/host/test/words.test.ts
  packages/host/test/boat-words.test.ts
  packages/protocol/test/person-words.test.ts
  apps/web/test/plain-words.test.ts
  packages/host/test/parity.test.ts
  packages/host/test/skill.test.ts
  packages/host/test/contract.test.ts
  packages/host/test/cloud.test.ts
  apps/web/test/no-caps.test.ts
  apps/web/test/no-separator-dots.test.ts
  packages/protocol/test/daemon-contract.test.ts
  packages/protocol/test/area-notes.test.ts
  packages/protocol/test/test-hygiene.test.ts
  packages/protocol/test/repo-names.test.ts
  packages/protocol/test/fixture-privacy.test.ts
  packages/host/test/file-size-check.test.ts
  apps/web/test/design-literals.test.ts
  apps/web/test/design-pieces.test.ts
  apps/web/test/has-selectors.test.ts
  packages/protocol/test/ts-parse.test.ts
  packages/protocol/test/law-list.test.ts
)

failed=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s: %s\n' "$1" "$2"; failed=1; }
warn() { printf 'WARN  %s: %s\n' "$1" "$2"; }
skip() { printf 'SKIP  %s: %s\n' "$1" "$2"; }
joined() { awk 'NR > 1 { printf "; " } { printf "%s", $0 } END { print "" }'; }

work=$(cd "$(mktemp -d)" && pwd -P)
trees=()
cleanup() {
  for t in ${trees[@]+"${trees[@]}"}; do git worktree remove --force "$t" >/dev/null 2>&1; done
  if [ $failed -eq 0 ]; then rm -rf "$work"; else echo "logs: $work"; fi
}
trap cleanup EXIT

# What a failed run's log says is missing from this checkout rather than wrong in the branch, with the line that
# builds it; empty when the log names nothing missing.
build_cause() {
  local hit bin triple causes=""
  hit=$(grep -oE "[^ '\"]+ is missing: run pnpm build first|Cannot find package [^ ]*/dist/[^ ]*" "$1" | head -n 1)
  [ -n "$hit" ] && causes="run pnpm build first, or scripts/pre-review.sh --build ($hit)"
  bin=$(grep -o 'wsp-daemon binary missing: [^ ]*' "$1" | head -n 1 | sed 's/.*missing: //')
  if [ -n "$bin" ]; then
    triple=$(basename "$(dirname "$bin")")
    causes="${causes:+$causes; }$bin is not built: cd daemon && cargo build --release --target $triple -p wsp-daemon-bin, then node packages/wspx/scripts/daemon-binary.mjs --triple $triple"
  fi
  printf '%s' "$causes"
}

# A commit no ref holds, by an author that needs no git config.
throwaway_commit() {
  GIT_AUTHOR_NAME=pre-review GIT_AUTHOR_EMAIL=pre-review@invalid GIT_COMMITTER_NAME=pre-review GIT_COMMITTER_EMAIL=pre-review@invalid git commit-tree "$@"
}

# Each line the diff adds in the paths named, as file:line:text.
added_lines() {
  git diff -U0 "$base" "$head" -- "$@" | awk '
    /^\+\+\+ / { file = substr($0, 7); next }
    /^@@ / { split($3, at, ","); line = substr(at[1], 2) + 0; next }
    /^\+/ { print file ":" line ":" substr($0, 2); line++ }'
}

fetched=1
git fetch -q origin main 2>/dev/null || fetched=0
main=$(git rev-parse -q --verify origin/main)
if [ -z "$main" ] && [ $laws_only -eq 0 ]; then echo "refused: this checkout has no origin/main" >&2; exit 2; fi
head=$(git rev-parse HEAD)
base=${main:+$(git merge-base "$main" "$head")}

if [ $laws_only -eq 0 ]; then
  if [ "$base" = "$main" ] && [ $fetched -eq 0 ]; then
    warn "the branch contains origin/main" "origin main could not be fetched, so this is the origin/main last fetched"
  elif [ "$base" = "$main" ]; then
    pass "the branch contains origin/main"
  else
    fail "the branch contains origin/main" "commits of origin/main it lacks: $(git rev-list --count "$head..$main"); merge origin/main in or rebase onto it"
  fi

  ahead=$(git rev-list --no-merges --count "$main..$head")
  if [ "$ahead" -eq 1 ]; then
    pass "one commit ahead of origin/main"
  else
    fail "one commit ahead of origin/main" "$ahead commits: $(git log --no-merges --format='%h %s' "$main..$head" | joined)"
  fi

  words=""
  long=""
  for c in $(git rev-list "$main..$head"); do
    hit=$(git log -1 --format=%B "$c" | grep -n -i -e $'\xe2\x80\x94' -e $'\xe2\x80\x93' -e 'wsp-map#' -e 'Generated with' | head -n 1)
    [ -n "$hit" ] && [ -z "$words" ] && words="$(git rev-parse --short "$c") line ${hit%%:*}: ${hit#*:}"
    case "$(git log -1 --format=%p "$c")" in *" "*) continue ;; esac
    subject=$(git log -1 --format=%s "$c")
    chars=$(node -e 'process.stdout.write(String([...process.argv[1]].length))' "$subject")
    [ "$chars" -ge 72 ] && [ -z "$long" ] && long="$(git rev-parse --short "$c") has $chars characters: $subject"
  done
  if [ -n "$words" ]; then
    fail "no dash, wsp-map# or Generated with in a commit message" "$words"
  else
    pass "no dash, wsp-map# or Generated with in a commit message"
  fi
  if [ -n "$long" ]; then
    fail "commit subject under 72 characters" "$long"
  else
    pass "commit subject under 72 characters"
  fi

  dirty=$(git diff --name-only HEAD -- | paste -sd ' ' -)
  if [ -n "$dirty" ]; then
    fail "every change is committed" "uncommitted changes to $dirty"
  else
    pass "every change is committed"
  fi
  untracked=$(git ls-files --others --exclude-standard -- packages apps daemon scripts | head -n 5 | paste -sd ' ' -)
  if [ -n "$untracked" ]; then
    warn "no file left out of the commit" "untracked, so in no commit: $untracked; git add it or delete it"
  else
    pass "no file left out of the commit"
  fi

  # The pre-commit hook judges what a commit adds against its parent. Run against a tree that holds the base with
  # the branch staged over it, it judges the whole branch by the same rules, with no second copy of them here.
  hooks=$(git config core.hooksPath || true)
  hook=${hooks:+$hooks/pre-commit}
  case "$hook" in /*|"") ;; *) hook=$root/$hook ;; esac
  [ -f "$hook" ] || hook=$root/.githooks/pre-commit
  staged=$work/staged
  if git worktree add -q --no-checkout --detach "$staged" "$base" >/dev/null 2>&1 && trees+=("$staged") && git -C "$staged" read-tree "$head"; then
    if said=$(cd "$staged" && sh "$hook" 2>&1); then
      pass "the pre-commit hook's rules (no em dash added, no ticket label)"
    else
      fail "the pre-commit hook's rules (no em dash added, no ticket label)" "$said"
    fi
  else
    fail "the pre-commit hook's rules (no em dash added, no ticket label)" "a scratch worktree at $base could not be made"
  fi

  # Written so that neither pattern matches its own line here.
  kills=$(added_lines ':!*.md' ':!*/fixtures/*' | grep -E '(^|[^[:alnum:]_-])(pkil[l][[:space:]]+(-[[:alnum:]]*f|--full)|kill[a]ll)([^[:alnum:]_-]|$)' | head -n 3 | joined)
  if [ -n "$kills" ]; then
    fail "no process killed by pattern" "start the process, record its pid and kill that pid: $kills"
  else
    pass "no process killed by pattern"
  fi

  # A require( after a quote on its line is inside a string (a stub or a node -e line), which is fine. One inside a
  # template literal that began on an earlier line is not told apart, so this warns and does not fail.
  requires=$(added_lines '*.ts' '*.tsx' '*.mts' '*.mjs' ':!*/fixtures/*' | grep -E '(^|[^[:alnum:]_.$])require\(' | awk '{
    text = $0; sub(/^[^:]*:[^:]*:/, "", text)
    before = substr(text, 1, index(text, "require(") - 1)
    if (!index(before, "\"") && !index(before, "\047") && !index(before, "`")) print
  }' | head -n 3 | joined)
  if [ -n "$requires" ]; then
    warn "no require( in an ES module" "use an import, or process.getBuiltinModule where it must be lazy: $requires"
  else
    pass "no require( in an ES module"
  fi
fi

if [ $build -eq 1 ]; then
  if scripts/heavy.sh pnpm --filter "@wsp/host..." build >"$work/build.log" 2>&1; then
    pass "the build of @wsp/host and the packages it loads"
  else
    fail "the build of @wsp/host and the packages it loads" "$(grep -E 'error|ERR' "$work/build.log" | head -n 3 | joined)"
  fi
fi

# The laws judge the tree that lands: this folder as it stands merged with origin/main, which a branch holding
# origin/main already is. Any other branch gets a throwaway merge commit in a worktree of its own, with what this
# checkout ignores (its installs and builds) linked in, and pnpm told not to reinstall into those links.
laws_at=$root
laws_env=()
if [ -z "$main" ]; then
  echo "the laws run on this folder alone: this checkout has no origin/main"
elif [ "$base" = "$main" ]; then
  echo "the laws run on this folder, which holds origin/main $(git rev-parse --short "$main")"
else
  folder=""
  cp "$(git rev-parse --git-path index)" "$work/index" &&
    folder=$(GIT_INDEX_FILE=$work/index sh -c 'git add -A && git write-tree') &&
    folder=$(throwaway_commit "$folder" -p "$head" -m "this folder as it stands")
  said=$(git merge-tree --write-tree --name-only --no-messages "$main" "$folder" 2>&1)
  case $? in
    0)
      merged=$work/merged
      merge=$(throwaway_commit "${said%%$'\n'*}" -p "$folder" -p "$main" -m "this folder merged with origin/main")
      if git worktree add -q --detach "$merged" "$merge" >/dev/null 2>&1; then
        trees+=("$merged")
        while IFS= read -r p; do
          p=${p%/}
          [ -d "$merged/$(dirname "$p")" ] && [ ! -e "$merged/$p" ] && ln -s "$root/$p" "$merged/$p"
        done < <(git ls-files --others --ignored --exclude-standard --directory)
        laws_at=$merged
        laws_env=(pnpm_config_verify_deps_before_run=false)
        echo "the laws run on this folder merged with origin/main $(git rev-parse --short "$main"), a throwaway merge commit $(git rev-parse --short "$merge") in $merged"
      else
        laws_at=""
        fail "the laws" "a worktree at the merge with origin/main could not be made"
      fi
      ;;
    1)
      laws_at=""
      fail "the laws" "this folder conflicts with origin/main $(git rev-parse --short "$main") in $(printf '%s\n' "$said" | tail -n +2 | grep -v '^$' | sort -u | joined), so no tree of it can land; merge origin/main in and resolve them"
      ;;
    *)
      laws_at=""
      fail "the laws" "git could not merge this folder with origin/main (git merge-tree --write-tree needs git 2.38): $(printf '%s' "$said" | tail -n 1)"
      ;;
  esac
fi

law_log=$work/laws.log
if [ -z "$laws_at" ]; then
  :
elif (cd "$laws_at" && env ${laws_env[@]+"${laws_env[@]}"} scripts/test-files.sh --tools "${LAWS[@]}") >"$law_log" 2>&1; then
  pass "the laws: $(grep -E '^ *Test Files' "$law_log" | sed 's/^ *Test Files *//')"
else
  reason=$(grep -o 'daemon/crates/wsp-mcp is behind this package.*commit them' "$law_log" | head -n 1)
  missing=$(build_cause "$law_log")
  [ -n "$missing" ] && reason="${reason:+$reason; }$missing"
  failing=$(grep -E '^ *FAIL ' "$law_log" | sed 's/^ *FAIL *//' | sort -u | head -n 5 | joined)
  fail "the laws" "${reason:-${failing:-see $law_log}}"
fi

if [ -z "$laws_at" ]; then
  :
elif [ -f "$laws_at/scripts/file-size-check.mjs" ]; then
  if said=$(cd "$laws_at" && node scripts/file-size-check.mjs 2>&1); then
    pass "the size check"
  else
    fail "the size check" "$(printf '%s' "$said" | tail -n 5)"
  fi
else
  skip "the size check" "scripts/file-size-check.mjs is not on this branch"
fi

if [ -z "$base" ] || [ -n "$(git diff --name-only "$base" -- daemon)" ]; then
  if ! command -v cargo >/dev/null 2>&1; then
    fail "cargo fmt --check" "daemon/ changed and cargo is not on PATH"
  elif said=$(cd daemon && ../scripts/heavy.sh cargo fmt --check 2>&1); then
    pass "cargo fmt --check"
  else
    fail "cargo fmt --check" "$(printf '%s\n' "$said" | grep '^Diff in' | sed 's/:$//' | head -n 3 | joined); run cargo fmt in daemon/"
  fi
else
  skip "cargo fmt --check" "nothing under daemon/ changed"
fi

[ $laws_only -eq 1 ] && exit $failed

changed=()
while IFS= read -r f; do
  [ -f "$f" ] && changed+=("$f")
done < <(git diff --name-only --diff-filter=AMR "$base" "$head" -- '*.test.ts' '*.test.tsx')
touched=()
for f in ${changed[@]+"${changed[@]}"}; do
  case " ${LAWS[*]} packages/host/test/mcp-record.test.ts packages/host/test/memory.test.ts packages/protocol/test/stub-script.test.ts " in
    *" $f "*) ;;
    *) touched+=("$f") ;;
  esac
done
if [ ${#touched[@]} -eq 0 ]; then
  skip "the touched tests" "the branch changes no test file outside the laws"
elif scripts/test-files.sh "${touched[@]}" >"$work/tests.log" 2>&1; then
  pass "the touched tests: $(grep -E '^ *Test Files' "$work/tests.log" | sed 's/^ *Test Files *//')"
else
  failing=$(build_cause "$work/tests.log")
  [ -n "$failing" ] || failing=$(grep -E '^ *FAIL ' "$work/tests.log" | sed 's/^ *FAIL *//' | sort -u | head -n 5 | joined)
  fail "the touched tests" "${failing:-see $work/tests.log}"
fi

# The test files the change reaches through imports, as affected-tests.mjs picks them for CI, less what ran above.
# The package folders CI runs whole are named and not run: for a change to a shared package they are most of the suite.
reached=()
folders=()
whole=""
broken=""
if [ ! -f scripts/affected-tests.mjs ]; then
  whole="scripts/affected-tests.mjs is not on this branch"
elif ! node scripts/affected-tests.mjs "$base" --files >"$work/affected.txt" 2>"$work/affected.why"; then
  broken=$(tail -n 1 "$work/affected.why")
elif [ ! -s "$work/affected.txt" ]; then
  whole="the change reaches the whole suite ($(grep '^everything ' "$work/affected.why" | head -n 1 | sed 's/^everything *//'))"
fi
if [ -z "$whole$broken" ]; then
  while IFS= read -r f; do
    case "$f" in
      */) folders+=("$f") ;;
      *)
        case " ${LAWS[*]} ${touched[*]-} packages/host/test/mcp-record.test.ts packages/host/test/memory.test.ts packages/protocol/test/stub-script.test.ts " in
          *" $f "*) ;;
          *) [ -f "$f" ] && reached+=("$f") ;;
        esac
        ;;
    esac
  done <"$work/affected.txt"
fi
if [ -n "$broken" ]; then
  fail "the affected tests" "scripts/affected-tests.mjs failed, so no affected file ran: $broken"
elif [ -n "$whole" ]; then
  warn "the affected tests" "$whole, so only the touched files ran; the rest waits on CI"
elif [ ${#reached[@]} -eq 0 ]; then
  skip "the affected tests" "every test file affected-tests.mjs names ran above"
elif scripts/test-files.sh "${reached[@]}" >"$work/affected.log" 2>&1; then
  pass "the affected tests, files affected-tests.mjs names: ${#reached[@]}; $(grep -E '^ *Test Files' "$work/affected.log" | sed 's/^ *Test Files *//')"
else
  failing=$(build_cause "$work/affected.log")
  [ -n "$failing" ] || failing=$(grep -E '^ *FAIL ' "$work/affected.log" | sed 's/^ *FAIL *//' | sort -u | head -n 5 | joined)
  fail "the affected tests, files affected-tests.mjs names: ${#reached[@]}" "${failing:-see $work/affected.log}"
fi
if [ ${#folders[@]} -gt 0 ]; then
  warn "the affected tests" "CI runs every test of ${folders[*]}; of those, only the files the change reaches through imports ran here"
fi

# The red proof: the branch's test files, with every test helper and fixture it changed, run on the merge-base's
# sources. node_modules are linked from this checkout, so the base runs on this branch's dependencies, and vitest is
# run without pnpm, whose dependency check there would reinstall into the linked folders.
if [ ${#changed[@]} -eq 0 ]; then
  skip "the red proof" "the branch changes no test file"
else
  red=$work/base
  if git worktree add -q --detach "$red" "$base" >/dev/null 2>&1; then
    trees+=("$red")
    for nm in node_modules packages/*/node_modules apps/*/node_modules infra/*/node_modules; do
      [ -d "$nm" ] && [ -d "$red/$(dirname "$nm")" ] && ln -s "$root/$nm" "$red/$nm"
    done
    while IFS= read -r f; do
      mkdir -p "$red/$(dirname "$f")" && git show "$head:$f" >"$red/$f"
    done < <(git diff --name-only --diff-filter=AMR "$base" "$head" -- '*/test/*' '*/fixtures/*')
    (cd "$red" && "$root/scripts/heavy.sh" "$root/node_modules/.bin/vitest" run --minWorkers=1 --maxWorkers=2 --reporter=json --outputFile="$work/red.json" "${changed[@]}" >"$work/red.log" 2>&1)
    if [ ! -f "$work/red.json" ]; then
      fail "the red proof" "vitest gave no result on the merge-base; see $work/red.log"
    else
      echo "red proof, the branch's test files on the merge-base $(git rev-parse --short "$base"):"
      # A file runs once per vitest project; the line for it is its worst run. A red whose words say something is
      # missing or not built is the base worktree lacking a build, which proves nothing about the change.
      node -e '
        const fs = require("node:fs");
        const [file, top] = process.argv.slice(1);
        const MISSING = /is missing: run pnpm build first|Cannot find (package|module) \S*\/dist\/|binary missing|not built/i;
        const firstLine = text => (text ?? "").split("\n").map(l => l.trim()).find(l => l !== "") ?? "";
        const worst = new Map();
        for (const r of JSON.parse(fs.readFileSync(file, "utf8")).testResults) {
          const path = r.name.slice(top.length + 1);
          const tests = r.assertionResults ?? [];
          const reds = tests.filter(t => t.status === "failed");
          const said = [r.message, ...reds.flatMap(t => t.failureMessages ?? [])].filter(Boolean);
          const real = said.filter(m => !MISSING.test(m));
          const rank = r.status !== "failed" ? 0 : real.length ? 2 : 1;
          if ((worst.get(path)?.rank ?? -1) < rank) worst.set(path, { rank, tests, reds, said, real });
        }
        for (const [path, { rank, tests, reds, said, real }] of [...worst].sort()) {
          const count = tests.length === 0 ? "fails to load" : `${reds.length} of ${tests.length} red`;
          if (rank === 2) console.log(`  red    ${path}: ${count}: ${firstLine(real[0])}`);
          else if (rank === 1) console.log(`  red for a missing build, not the change: ${path}: ${firstLine(said[0])}`);
          else console.log(`  green  ${path}: passes on the base, so it shows nothing this change fixed`);
        }' "$work/red.json" "$red"
    fi
  else
    fail "the red proof" "a worktree at $base could not be made"
  fi
fi

if [ -n "$ticket" ] && ! gh auth status >/dev/null 2>&1; then
  skip "the ticket" "gh is not signed in here, and $tickets is private; run gh auth login, or read #$ticket by hand"
elif [ -n "$ticket" ]; then
  if gh api "repos/$tickets/issues/$ticket" >"$work/issue.json" 2>"$work/gh.log" &&
    gh api --paginate "repos/$tickets/issues/$ticket/comments" --jq '.[]' >"$work/comments.jsonl" 2>>"$work/gh.log"; then
    echo "$tickets#$ticket: the report answers each line as met with its evidence, deviated with the reason, or not done"
    node -e '
      const fs = require("node:fs");
      const issue = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const comments = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
      const ACCEPT = /^(answer to (build|deliver)|acceptance|done when|fix|the work|target)\b/i;
      const RULED = /\b(rul(ed|ing|ings)|decisions? so far|decided)\b/i;
      const OPENS_RULED = /^\s*(#+\s*)?(\*\*)?(the\s+)?(coordinator.s\s+)?(rul(ed|ing|ings)|decisions?)\b/i;
      const sections = md => {
        const out = [{ head: "", lines: [] }];
        let fenced = false;
        for (const line of (md ?? "").replace(/\r/g, "").split("\n")) {
          if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
          if (fenced || /^Map:/.test(line)) continue;
          const h = /^#{1,6}\s+(.*)$/.exec(line);
          if (h) out.push({ head: h[1].trim(), lines: [] });
          else out.at(-1).lines.push(line);
        }
        return out;
      };
      const items = (lines, listOnly = false) => {
        const list = [], paras = [];
        let para = [], open = false;
        const close = () => { if (para.length) paras.push(para.join(" ")); para = []; };
        for (const line of lines) {
          const m = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
          if (m) { close(); list.push(m[1].trim()); open = true; }
          else if (line.trim() === "") { close(); open = false; }
          else if (open) list[list.length - 1] += " " + line.trim();
          else para.push(line.trim());
        }
        close();
        if (listOnly && list.length) return list;
        const prose = list.length ? paras : paras.flatMap(p => p.split(/(?<!\b(?:e\.g|i\.e|vs|etc)\.)(?<=[.!?])\s+(?=\S)/));
        return [...list, ...prose].filter(s => s.length > 0);
      };
      const body = sections(issue.body);
      const asked = body.filter(s => ACCEPT.test(s.head));
      const acceptance = (asked.length ? asked : body.filter(s => !RULED.test(s.head))).flatMap(s => items(s.lines));
      if (!asked.length) console.log("  (no acceptance section, so every line of the body)");
      acceptance.forEach((t, i) => console.log(`  A${i + 1}  ${t}`));
      const rulings = body.filter(s => RULED.test(s.head)).flatMap(s => items(s.lines).map(t => `[body: ${s.head}] ${t}`));
      for (const c of comments) {
        const lines = (c.body ?? "").replace(/\r/g, "").split("\n");
        const first = lines.findIndex(l => l.trim() !== "");
        if (first < 0 || !OPENS_RULED.test(lines[first])) continue;
        const rest = items(sections(lines.slice(first + 1).join("\n")).flatMap(s => s.lines), true);
        for (const t of rest.length ? rest : [lines[first].replace(/^#+\s*/, "")]) rulings.push(`[comment ${c.id}, ${c.created_at.slice(0, 10)}] ${t}`);
      }
      rulings.forEach((t, i) => console.log(`  R${i + 1}  ${t}`));
      console.log(`  (${rulings.length ? "" : "no ruling found; "}rulings are read from body sections headed ruled, ruling or decisions, and from comments that open with ruling, ruled or the coordinator naming its rulings)`);' "$work/issue.json" "$work/comments.jsonl"
  else
    fail "the ticket" "$tickets#$ticket could not be read: $(tail -n 1 "$work/gh.log")"
  fi
fi

exit $failed
