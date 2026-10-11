// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The one executable every stub runs. It is read only, so a write through a stub's link fails instead of landing here. */
// __dirname and not import.meta.url: under the web project's jsdom the module's URL is not a file URL.
export const STUB_RUNNER = join(__dirname, "stub-runner.sh");
chmodSync(STUB_RUNNER, 0o555);
// The runner's own first exec pays the check once, here at import rather than inside a case's wait.
spawnSync(STUB_RUNNER);

/** A script a test or the code under test runs by path or by name on a PATH, without a fresh file's first exec:
 * the path is a link to the runner and the script sits beside it, read by the interpreter its first line names.
 * Returns the path. */
export function writeStub(path: string, script: string): string {
  writeFileSync(join(dirname(path), `.${basename(path)}.stub`), script);
  if (!isRunnerLink(path)) {
    rmSync(path, { force: true });
    symlinkSync(STUB_RUNNER, path);
  }
  return path;
}

/** A shell loop that waits for the gate file, running `each` on every pass, and ends its shell once the gate's folder
 * is gone or after `limitS` seconds, so a run no sweep reached stops polling by itself. The gate is read inside double
 * quotes, so it is a path or a word such as `$GATE`. The clock is read every 20th pass, not counted in passes: a pass
 * took twice its sleep on a Mac runner. */
export function gateLoop(gate: string, { each = "", limitS = 30 }: { each?: string; limitS?: number } = {}): string {
  const pass = each === "" ? "" : `${each}; `;
  return `_g="${gate}"; _end=$(($(date +%s) + ${limitS})); _n=0; while [ ! -f "$_g" ]; do { [ -d "\${_g%/*}" ] && { [ $((_n % 20)) -ne 0 ] || [ "$(date +%s)" -le $_end ]; }; } || exit 1; ${pass}sleep 0.05; _n=$((_n + 1)); done`;
}

function isRunnerLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === STUB_RUNNER;
  } catch {
    return false;
  }
}
