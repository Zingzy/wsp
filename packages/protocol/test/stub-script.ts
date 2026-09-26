// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The one executable every stub runs. It is read only, so a write through a stub's link fails instead of landing here. */
// __dirname and not import.meta.url: under the web project's jsdom the module's URL is not a file URL.
export const STUB_RUNNER = join(__dirname, "stub-runner.sh");
chmodSync(STUB_RUNNER, 0o555);
// The runner's own first exec pays the check once, here at import rather than inside a case's wait.
execFileSync(STUB_RUNNER);

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

function isRunnerLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === STUB_RUNNER;
  } catch {
    return false;
  }
}
