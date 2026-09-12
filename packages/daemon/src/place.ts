// SPDX-License-Identifier: AGPL-3.0-only
// What a computer joined as a place says about itself when its daemon is the
// agent that dials, and what its leave takes. Both are read off the home the
// daemon was pointed at, so a daemon started with a place file and a home
// reports and sweeps with no host code beside it. The host's own agent reads
// its login shell for the PATH a turn runs under; this report reads the
// environment it was started with, which on a service unit is what the unit
// stated.
import { accessSync, constants, existsSync, rmSync, statfsSync } from "node:fs";
import { arch, cpus, hostname, platform, release, totalmem, type as osType, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { DAEMON_VERSION, placeOwnedPaths, workFolderIn } from "@wsp/protocol";
import { readPlaceFile, type PlaceSelfReport } from "./link.js";

export interface PlaceSelfReportInput {
  /** The place file, whose name is the one the host knows this computer by. */
  file: string;
  home: string;
  /** The line that runs wsp on this computer, word by word. */
  wspArgv: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** Whether a command by this name sits on the PATH given, which is what "can fork" means for docker here. */
function onPath(name: string, path: string | undefined): boolean {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** How much room is left on the volume the work folder sits on, or nothing when this computer will not say. */
function diskFree(folder: string): number | undefined {
  try {
    const fs = statfsSync(folder);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return undefined;
  }
}

/** What this computer says about itself on every link, read at each dial rather than once: a laptop gains a
 * Docker, loses a disk and is renamed under wsp rather than by it. */
export function placeSelfReport(input: PlaceSelfReportInput): PlaceSelfReport {
  const env = input.env ?? process.env;
  const work = workFolderIn(input.home);
  const free = diskFree(existsSync(work) ? work : input.home);
  return {
    name: readPlaceFile(input.file)?.name ?? hostname().toLowerCase(),
    platform: platform() === "darwin" ? "darwin" : "linux",
    arch: arch(),
    os: `${osType()} ${release()}`,
    shape: { cpu: cpus().length, memMb: Math.round(totalmem() / (1024 * 1024)) },
    ...(free !== undefined ? { diskFreeBytes: free } : {}),
    login: { HOME: input.home, USER: userInfo().username, PATH: env["PATH"] ?? "" },
    docker: onPath("docker", env["PATH"]),
    daemonVersion: DAEMON_VERSION,
    wsp: [...input.wspArgv],
  };
}

/** Takes wsp off this computer, by the one list the protocol names, and answers what went. The work folder stays:
 * what the person's threads wrote there is theirs. The unit that holds this agent up is the service manager's and
 * its name is the host's rule; it is not here, so the host's own leave is what takes it. */
export function sweepPlaceHome(home: string): string[] {
  const removed: string[] = [];
  for (const path of placeOwnedPaths(home)) {
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return removed;
}
