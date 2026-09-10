// SPDX-License-Identifier: AGPL-3.0-only
// The PATH the host runs under. launchd hands every app it starts the four
// system folders and nothing a person installed, so a host opened from Finder
// or the Dock cannot see claude, codex or any other tool in a user folder, and
// neither can anything it looks up or spawns. One read of the login shell at
// the host's start settles it for the whole process. That PATH is the whole
// trigger: any other one was meant by whoever set it, and replacing it would
// make the start depend on the machine's rc files for no reason.
import { execFile } from "node:child_process";
import { loginPathLine } from "@wsp/protocol";

/** The PATH launchd gives an app it starts. The order it comes in is not fixed, so the reading is a set. */
export const LAUNCHD_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** How long the login shell is given. A shell that sources a version manager on a busy machine can pass five
 * seconds, and a host that then keeps launchd's PATH is this bug again, quieter; the start waits on this once, so
 * the limit is only ever paid when the shell is broken. */
const SHELL_LIMIT_MS = 15_000;

export interface LoginShellDeps {
  env: NodeJS.ProcessEnv;
  log(line: string): void;
  /** Runs the login shell and answers with everything it printed; the real one unless a test hands over its own. */
  read?: (shell: string) => Promise<string>;
}

/** Whether this launch has to ask the login shell: its PATH is launchd's own set, in any order and nothing else. */
export function needsLoginPath(env: NodeJS.ProcessEnv): boolean {
  const dirs = (env["PATH"] ?? "").split(":").filter(dir => dir !== "");
  return dirs.length === LAUNCHD_PATH.length && LAUNCHD_PATH.every(dir => dirs.includes(dir));
}

function runLoginShell(shell: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(shell, ["-ilc", 'printf %s "$PATH"'], { timeout: SHELL_LIMIT_MS, encoding: "utf8" }, (e, stdout) => (e === null ? resolve(stdout) : reject(e)));
  });
}

/** Puts the person's login shell PATH on the environment, or says in one line why the one this launch was given
 * stands. A shell that fails, times out or prints nothing changes nothing. */
export async function takeLoginPath(deps: LoginShellDeps): Promise<void> {
  if (!needsLoginPath(deps.env)) return;
  const shell = deps.env["SHELL"];
  if (shell === undefined || shell === "") {
    deps.log(loginPathLine("SHELL names no login shell"));
    return;
  }
  let out: string;
  try {
    out = await (deps.read ?? runLoginShell)(shell);
  } catch (e) {
    deps.log(loginPathLine(`${shell} failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0] ?? ""}`));
    return;
  }
  // printf ends without a newline, so the PATH is whatever follows the last one: an rc file that greets the person
  // prints its greeting first.
  const path = (out.split("\n").at(-1) ?? "").trim();
  if (path === "") {
    deps.log(loginPathLine(`${shell} printed nothing`));
    return;
  }
  deps.env["PATH"] = path;
}

let taken: Promise<void> | undefined;

/** The login shell is asked once per process, at the host's start and before it looks any command up. */
export function adoptLoginPath(log: (line: string) => void): Promise<void> {
  return (taken ??= takeLoginPath({ env: process.env, log }));
}
