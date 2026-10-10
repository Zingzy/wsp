// SPDX-License-Identifier: AGPL-3.0-only
// One thread's processes on a computer the person joined stand in a cgroup of
// their own, for telling them apart and ending them together, never to limit
// them: nothing is set on it but its members. The daemon there is root, so the
// launch stands itself in it before it hands the line to the login, and every
// process the turn starts, a server it detached included, stands there too.
import { CGROUP_MOUNT, THREAD_CGROUPS as THREADS } from "./daemon-contract.js";
import { shellQuote } from "./shell-quote.js";

/** The cgroup a thread's processes stand in, as /proc/[pid]/cgroup names it and a process row carries it. */
export function threadCgroup(threadId: string): string {
  return `${THREADS}/${threadId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Whether a process row's cgroup is this one or one under it. */
export function inCgroup(at: string | undefined, cgroup: string): boolean {
  return at !== undefined && (at === cgroup || at.startsWith(`${cgroup}/`));
}

/** The line a launch runs as root before it hands its command to the login: the shell stands itself in the thread's
 * cgroup, so what it starts stands there too. A computer with no cgroup v2, or one that will not take the folder,
 * launches the same command where it stands, since the cgroup tracks and never gates. */
export function cgroupJoinLine(cgroup: string): string {
  const at = shellQuote(`${CGROUP_MOUNT}${cgroup}`);
  return `[ -f ${CGROUP_MOUNT}/cgroup.controllers ] && mkdir -p ${at} 2>/dev/null && echo $$ > ${at}/cgroup.procs 2>/dev/null; true`;
}

/** How long a thread's processes get between TERM and KILL, and after KILL, in tenths of a second. */
const GRACE_TENTHS = 30;
const KILLED_TENTHS = 10;

/** The shell function that ends one thread's cgroup, `wsp_end <cgroup> <remove>`, as root: what stands in it and every
 * cgroup under it when it starts, by pid, TERM, then KILL what is still there after the grace. A process that joins
 * meanwhile is the next turn's and is left be. With remove 1 the thread is going, so the cgroups are emptied whole and
 * taken away, deepest first. Returns non-zero naming what survived; a cgroup that is not there is nothing to end. */
const END_FUNCTION = [
  "wsp_end() {",
  `  C=$1; at="${CGROUP_MOUNT}$1"`,
  '  [ -d "$at" ] || return 0',
  // Still running and still the thread's: a pid the kernel handed to another process since is neither.
  `  mine() { g=$(sed -n 's/^0:://p' /proc/$1/cgroup 2>/dev/null); case "$g" in "$C"|"$C"/*) ;; *) return 1 ;; esac; s=$(sed 's/.*) //' /proc/$1/stat 2>/dev/null); [ -n "$s" ] && [ "\${s%% *}" != Z ]; }`,
  '  left() { L=; for p in $P; do mine "$p" && L="$L $p"; done; P=$L; }',
  '  P=$(find "$at" -name cgroup.procs -exec cat {} + 2>/dev/null)',
  '  [ -n "$P" ] && kill -TERM $P 2>/dev/null',
  `  i=0; left; while [ $i -lt ${GRACE_TENTHS} ] && [ -n "$P" ]; do sleep 0.1; i=$((i+1)); left; done`,
  '  [ -n "$P" ] && kill -KILL $P 2>/dev/null',
  `  i=0; left; while [ $i -lt ${KILLED_TENTHS} ] && [ -n "$P" ]; do sleep 0.1; i=$((i+1)); left; done`,
  '  [ -z "$P" ] || { echo "processes$P of $C did not end" >&2; return 1; }',
  '  [ "$2" = 1 ] || return 0',
  '  echo 1 > "$at/cgroup.kill" 2>/dev/null || { Q=$(find "$at" -name cgroup.procs -exec cat {} + 2>/dev/null); [ -n "$Q" ] && kill -KILL $Q 2>/dev/null; }',
  `  i=0; while [ $i -lt ${GRACE_TENTHS} ] && [ -d "$at" ]; do find "$at" -depth -type d -exec rmdir {} + 2>/dev/null; [ -d "$at" ] && sleep 0.1; i=$((i+1)); done`,
  '  [ -d "$at" ] && { echo "$C still holds processes" >&2; return 1; }',
  "  return 0",
  "}",
].join("\n");

/** Ends one thread's cgroup as root, and with `remove` takes it away (END_FUNCTION). */
export function cgroupEndScript(cgroup: string, o: { remove?: boolean } = {}): string {
  return `${END_FUNCTION}\nwsp_end ${shellQuote(cgroup)} ${o.remove === true ? 1 : 0}`;
}

/** Ends and takes away every thread's cgroup on the computer, as a leave does, printing each one it took. `under` is
 * the folder they sit in, which only a test names. */
export function threadCgroupsEndScript(under: string = THREADS): string {
  const at = shellQuote(`${CGROUP_MOUNT}${under}`);
  return [
    END_FUNCTION,
    `[ -d ${at} ] || exit 0`,
    `for d in ${at}/*/; do [ -d "$d" ] || continue; t=$(basename "$d"); wsp_end ${shellQuote(under)}/"$t" 1 && echo ${shellQuote(`${CGROUP_MOUNT}${under}`)}/"$t"; done`,
    `rmdir ${at} 2>/dev/null`,
    "exit 0",
  ].join("\n");
}
