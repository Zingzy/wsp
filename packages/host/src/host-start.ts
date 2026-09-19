// SPDX-License-Identifier: AGPL-3.0-only
// The host a verb brings up for itself. A line that needs the host serving
// this state file and finds none starts one detached and waits for its lock,
// so nobody has to type wsp up to get going, and wsp down stops what a verb
// started.
import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fmtDuration } from "@wsp/protocol";
import { hostLogPath, STARTED_BY_ENV, type HostLock } from "./host-lock.js";
import { runningWsp, wspCommand, type RunningWsp } from "./mcp-install.js";
import { httpProbe, logTail, registeredService, SERVICE_WAIT_MS, untilServing, type HostProbe, type RegisteredService } from "./service.js";

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
  /** What this computer's own manager is registered to serve this state file with, and nothing where none is.
   * One reading, in service.ts, so this road and wsp up refuse on the same fact. */
  registered: (statePath: string) => RegisteredService | undefined;
}

/** The one line a verb prints before it waits, on stderr whatever the line prints on stdout. */
export const startingHostLine = (statePath: string, logPath: string): string => `starting the host for ${statePath}; its log is ${logPath}, and wsp down stops it`;

/** A child that took the wait and never served: one refusal naming the file it was started for. */
export const noHostAnsweredLine = (statePath: string, waitMs: number): string => `no host answered for ${statePath} within ${fmtDuration(waitMs)}`;

/** Why a line starts no host of its own: this computer's own manager is registered to serve that state file, and
 * a host of whatever build happened to be on the line would read those records and write them back in its own
 * shape under the one that owns them. The one line named starts the service whether the manager has the unit
 * loaded or not, so a person reads one road out of either state. */
export const serviceServesStateLine = (statePath: string, service: RegisteredService): string =>
  `${statePath} is served by the ${service.words} ${service.unit.name}, which is not running; wsp up --service --state ${statePath} starts it again`;

export function hostStarter(deps: StartDeps): HostStarter {
  return async (statePath, say) => {
    // Before anything is spawned: a state file the service owns is served by the service or by nothing.
    const service = deps.registered(statePath);
    if (service !== undefined) throw new Error(serviceServesStateLine(statePath, service));
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
  return hostStarter({ spawn: nodeSpawn, wsp: wspCommand(run), env, waitMs: SERVICE_WAIT_MS, answers: httpProbe, registered: registeredService });
}
