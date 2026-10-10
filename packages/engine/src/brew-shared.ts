// SPDX-License-Identifier: AGPL-3.0-only
// The shared Homebrew step: the dependencies two or more of a recipe's formulae share, installed in one brew
// process before any of them, and its check, each saying in words what is missing when it fails.
import { shellQuote } from "@wsp/protocol";
import { asLinuxbrewScript, BREW } from "@wsp/catalog";

// Homebrew's Linux bottles are built against a newer glibc than the base image
// ships, so its first formula pulls Homebrew's own glibc and gcc in and, on
// 6.0.21, a nested brew racing the parent for those locks fails one run in
// two (measured: 4 of 7 plain runs failed, 3 of 3 passed with these first).
// Each is its own single brew process, in this order, before any formula.
export const BREW_TOOLCHAIN: readonly string[] = ["glibc", "gcc"];

/** The lines that put each formula's dependencies in `deps` and those two or more of them share in `shared`,
 * Homebrew's own toolchain left out: the step installs them and its check reads them back, so the list is derived
 * once and the two cannot ask about different formulae. */
const sharedDepsLines = (formulae: readonly string[]): string[] => [
  `deps=$(${BREW} deps --for-each ${formulae.map(shellQuote).join(" ")})`,
  `shared=$(printf '%s\\n' "$deps" | sed 's/^[^:]*: *//' | tr ' ' '\\n' | grep -vx -e '' ${BREW_TOOLCHAIN.map(f => `-e ${f}`).join(" ")} | sort | uniq -d || true)`,
];

/** Reads `deps` on stdin and prints on one line which of `shared` brew did not list in `have`: with `names`, the
 * names alone; otherwise each with the formulae that need it. A row's note is that one line, so three are named and
 * the rest counted. Written for mawk, Debian's awk, which makes an array's entry on an assignment's left before it
 * reads the right. */
const UNLISTED_AWK = String.raw`{ f = $1; sub(/:$/, "", f); for (i = 2; i <= NF; i++) if ($i in users) users[$i] = users[$i] SUBSEP f; else users[$i] = f }
END {
  m = split(ENVIRON["have"], h, "\n"); for (i = 1; i <= m; i++) { split(h[i], w, " "); got[w[1]] = 1 }
  n = split(ENVIRON["shared"], s, /[ \n]+/); k = 0
  for (i = 1; i <= n; i++) { b = s[i]; sub(/.*\//, "", b); if (s[i] != "" && !(b in got)) gone[++k] = s[i] }
  out = ""
  for (i = 1; i <= k && i <= 3; i++) {
    if (ENVIRON["names"] != "") { out = out (i == 1 ? "" : (i == k ? " and " : ", ")) gone[i]; continue }
    u = split(users[gone[i]], who, SUBSEP); list = ""
    for (j = 1; j <= u; j++) list = list (j == 1 ? "" : (j == u ? " and " : ", ")) who[j]
    out = out (i == 1 ? "" : " ") gone[i] " is not installed; " list (u == 1 ? " needs" : " need") " it."
  }
  if (k > 3) out = out (ENVIRON["names"] != "" ? " and " (k - 3) " more" : " " (k - 3) (k == 4 ? " more shared dependency is" : " more shared dependencies are") " not installed.")
  if (k > 0) print out
}`;
const unlisted = (names: boolean): string => `printf '%s\\n' "$deps" | ${names ? "names=1 " : ""}shared="$shared" have="$have" awk '${UNLISTED_AWK}'`;

/** Dependencies two or more of the formulae share install in one brew process before any of them, marked as
 * dependencies so autoremove still owns them; each formula then finds its shared dependencies present and installs
 * only its own. brew's stderr is held and replayed, so a failure's last line names the formulae still missing and
 * the last line brew printed; it opens with Error: since that is the line a failed step's note is read from. */
export function brewSharedDeps(formulae: readonly string[]): string {
  return asLinuxbrewScript(
    [
      "set -uo pipefail",
      ...sharedDepsLines(formulae),
      'if [ -z "$shared" ]; then echo "no shared dependencies"; exit 0; fi',
      'echo "shared: $(echo $shared)"',
      'err=$(mktemp)',
      `${BREW} install $shared 2>"$err"; rc=$?`,
      'cat "$err" >&2',
      `${BREW} tab --no-installed-on-request $shared || true`,
      'if [ $rc -ne 0 ]; then',
      `  have=$(${BREW} list --versions $shared 2>/dev/null)`,
      `  gone=$(${unlisted(true)})`,
      `  last=$(grep -v '^[[:space:]]*$' "$err" | tail -1 | sed 's/^[[:space:]]*//')`,
      '  if [ -n "$gone" ]; then echo "Error: $gone did not install${last:+: ${last#Error: }}" >&2; fi',
      "fi",
      'rm -f "$err"',
      "exit $rc",
    ].join("\n"),
  );
}

/** Whether the dependencies the shared step installs are already on the machine: the same list that step derives,
 * read back by Homebrew's own list. A list with nothing in it is a step with nothing to do rather than a row that
 * failed, and a formula of its own that did not install is that row's failure and not this one's. Its last line on
 * failure names what is missing and the formulae that need it, or brew's own error when brew could not list them. */
export const brewSharedCheck = (formulae: readonly string[]): string =>
  asLinuxbrewScript(
    [
      "set -uo pipefail",
      ...sharedDepsLines(formulae),
      'if [ -z "$shared" ]; then exit 0; fi',
      `have=$(${BREW} list --versions $shared 2>&1) && exit 0`,
      `case "$have" in *Error:*) printf '%s\\n' "$have" | grep Error: | tail -1; exit 1 ;; esac`,
      unlisted(false),
      "exit 1",
    ].join("\n"),
  );
