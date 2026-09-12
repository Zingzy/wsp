// SPDX-License-Identifier: AGPL-3.0-only
// The host a verb brings up for itself. A line that needs the host serving
// this state file and finds none starts one detached and waits for its lock,
// so nobody has to type wsp up to get going, and wsp down stops what a verb
// started.
import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fmtDuration } from "@wsp/protocol";
import { hostLogPath, type HostLock } from "./host-lock.js";
import { runningWsp, wspCommand, type RunningWsp } from "./mcp-install.js";
import { httpProbe, logTail, SERVICE_WAIT_MS, untilServing, type HostProbe } from "./service.js";

/** The variable a verb's child carries, which the host it starts writes into its lock, so wsp down can tell a host
 * nobody is watching from one a person is holding open in a terminal. */
export const STARTED_BY_ENV = "WSP_STARTED_BY";

/** Whether this process is the host a verb started, read off the environment it was spawned with. */
export const startedByVerb = (env: Readonly<Record<string, string | undefined>>): boolean => env[STARTED_BY_ENV] === "verb";

/** Starts a host serving this state file on this computer and answers with its lock once it answers on its port. */
export interface HostStarter {
  (statePath: string, say: (line: string) => void): Promise<HostLock>;
}

export interface StartDeps {
  spawn: typeof nodeSpawn;
  /** The line that starts this same wsp again, off the one rule an agent's config is written by. */
  wsp: { command: string; args: readonly string[] };
  env: Readonly<Record<string, string | undefined>>;
  waitMs: number;
  answers: HostProbe;
}

/** The one line a verb prints before it waits, on stderr whatever the line prints on stdout. */
export const startingHostLine = (statePath: string, logPath: string): string => `starting the host for ${statePath}; its log is ${logPath}, and wsp down stops it`;

/** A child that took the wait and never served: one refusal naming the file it was started for. */
export const noHostAnsweredLine = (statePath: string, waitMs: number): string => `no host answered for ${statePath} within ${fmtDuration(waitMs)}`;

export function hostStarter(deps: StartDeps): HostStarter {
  return async (statePath, say) => {
    const logPath = hostLogPath(statePath);
    mkdirSync(dirname(logPath), { recursive: true });
    const log = openSync(logPath, "a");
    try {
      // Free ports on purpose: another host, the app's or a service, often holds the default on this computer, and
      // every client dials the address the lock records rather than a number written down anywhere.
      const child = deps.spawn(deps.wsp.command, [...deps.wsp.args, "up", "--state", statePath, "--port", "0", "--ws-port", "0"], {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...deps.env, [STARTED_BY_ENV]: "verb" },
      });
      child.unref();
    } finally {
      closeSync(log);
    }
    say(startingHostLine(statePath, logPath));
    // Two verbs starting at once need no coordination: the second child's lock is refused and it dies, and this
    // wait sees the first child's lock.
    const lock = await untilServing(statePath, deps.waitMs, deps.answers);
    if (lock === undefined) throw new Error([noHostAnsweredLine(statePath, deps.waitMs), ...logTail(logPath)].join("\n"));
    return lock;
  };
}

/** The starter for a process that knows how it was started: the same line an agent's config would be given, with
 * the wait a service load is given. */
export function starterFor(run: RunningWsp = runningWsp(), env: Readonly<Record<string, string | undefined>> = process.env): HostStarter {
  return hostStarter({ spawn: nodeSpawn, wsp: wspCommand(run), env, waitMs: SERVICE_WAIT_MS, answers: httpProbe });
}
