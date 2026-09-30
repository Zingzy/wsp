// SPDX-License-Identifier: AGPL-3.0-only
// A run leaves no wsp-daemon of this checkout's running. A daemon is a child
// process, and one whose case timed out or crashed before its close outlives
// the run with parent pid 1: fifteen were found on one Mac a day later. The
// daemons this checkout's binaries run are noted as the run starts, and any
// new one still running once every worker is gone fails the run by pid. It
// names them and stops none: which case started one is read off its argv
// here, not recorded, and a case stops its own through the process it holds.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** This checkout as the binaries are spawned from it, by either spelling of its path. */
const ROOTS = [...new Set([HERE, `${realpathSync(HERE)}${sep}`])];
/** A worktree kept inside this checkout is another run's, whose binaries sit under this path too. */
const NESTED = ROOTS.map(root => join(root, ".claude", "worktrees") + sep);
/** The binary a process runs, read off the front of its argv, where it is a wsp-daemon. */
const DAEMON = /^(.*?[\\/]wsp-daemon)(\s|$)/;

/** Every wsp-daemon running off this checkout's own files, by pid, with the argv it runs with. */
function daemonsOfThisCheckout(): Map<number, string> {
  const found = new Map<number, string>();
  for (const line of execFileSync("ps", ["-e", "-o", "pid=,args="], { encoding: "utf8" }).split("\n")) {
    const at = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (at === null) continue;
    const bin = DAEMON.exec(at[2]!)?.[1];
    if (bin === undefined || !ROOTS.some(root => bin.startsWith(root)) || NESTED.some(nested => bin.startsWith(nested))) continue;
    found.set(Number(at[1]), at[2]!);
  }
  return found;
}

export default function setup(): () => void {
  const before = new Set(daemonsOfThisCheckout().keys());
  return () => {
    const left = [...daemonsOfThisCheckout()].filter(([pid]) => !before.has(pid));
    if (left.length === 0) return;
    throw new Error(
      [
        `this run left ${left.length} wsp-daemon${left.length === 1 ? "" : "s"} of this checkout running after every test ended:`,
        ...left.map(([pid, argv]) => `  pid ${pid}: ${argv}`),
        "A case that starts a daemon stops it in its own teardown through the process LocalDaemonOptions.spawned handed it.",
      ].join("\n"),
    );
  };
}
