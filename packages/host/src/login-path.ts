// SPDX-License-Identifier: AGPL-3.0-only
// The PATH the host runs under. launchd hands every app it starts the four
// system folders and nothing a person installed, so a host opened from Finder
// or the Dock cannot see claude, codex or any other tool in a user folder, and
// neither can anything it looks up or spawns. One read of the login shell at
// the host's start settles it for the whole process. That PATH is the whole
// trigger: any other one was meant by whoever set it, and replacing it would
// make the start depend on the machine's rc files for no reason.
//
// Every road into the app awaits this before it builds a runtime, not merely
// before it serves: building one asks this computer what it holds, and every
// lookup and spawn the host makes on the way reads the PATH this process has at
// that moment. The read is once per process, so a road that follows another
// pays nothing for saying so.
import { spawnRun } from "@wsp/collect";
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
  /** Runs the login shell and answers with everything it printed, or nothing where it failed or ran past its limit;
   * the real one unless a test hands over its own. */
  read?: (shell: string) => Promise<string | undefined>;
}

/** Whether this launch has to ask the login shell: its PATH is launchd's own set, in any order and nothing else. */
export function needsLoginPath(env: NodeJS.ProcessEnv): boolean {
  const dirs = (env["PATH"] ?? "").split(":").filter(dir => dir !== "");
  return dirs.length === LAUNCHD_PATH.length && LAUNCHD_PATH.every(dir => dirs.includes(dir));
}

/** A job an rc file leaves in the background keeps the shell's output open past its exit, so the shell leads a
 * process group that dies with the read, and its input is closed so an rc file that reads it does not wait. */
const runLoginShell = (shell: string, script: string): Promise<string | undefined> => spawnRun(shell, ["-ilc", script], process.env, { timeoutMs: SHELL_LIMIT_MS });

/** Puts the person's login shell PATH on the environment, or says in one line why the one this launch was given
 * stands. A shell that fails, times out or prints nothing changes nothing. */
export async function takeLoginPath(deps: LoginShellDeps): Promise<void> {
  if (!needsLoginPath(deps.env)) return;
  const shell = deps.env["SHELL"];
  if (shell === undefined || shell === "") {
    deps.log(loginPathLine("SHELL names no login shell"));
    return;
  }
  const out = await (deps.read ?? (sh => runLoginShell(sh, 'printf %s "$PATH"')))(shell);
  if (out === undefined) {
    deps.log(loginPathLine(`${shell} failed or ran past ${SHELL_LIMIT_MS / 1000} s`));
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

/** Every variable `env -0` printed, NUL between them; the first carries whatever an rc file printed before it, which
 * ends at its last newline. */
export function loginEnvOf(out: string): Record<string, string> {
  const env: Record<string, string> = {};
  out.split("\0").forEach((entry, at) => {
    const line = at === 0 ? entry.slice(entry.lastIndexOf("\n") + 1) : entry;
    const eq = line.indexOf("=");
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, eq))) env[line.slice(0, eq)] = line.slice(eq + 1);
  });
  return env;
}

let loginEnvRead: Promise<Readonly<Record<string, string>>> | undefined;

/** The person's login shell environment, read once per process the way its PATH is, for a process that should see what
 * their own agent sees; nothing where the shell fails. */
export function loginEnv(): Promise<Readonly<Record<string, string>>> {
  const shell = process.env["SHELL"];
  return (loginEnvRead ??=
    shell === undefined || shell === ""
      ? Promise.resolve({})
      : runLoginShell(shell, "env -0").then(out => {
          if (out === undefined) console.error(loginPathLine(`${shell} failed or ran past ${SHELL_LIMIT_MS / 1000} s printing its environment`));
          return out === undefined ? {} : loginEnvOf(out);
        }));
}

let taken: Promise<void> | undefined;

/** The login shell is asked once per process, at the host's start and before it looks any command up. */
export function adoptLoginPath(log: (line: string) => void): Promise<void> {
  return (taken ??= takeLoginPath({ env: process.env, log }));
}
