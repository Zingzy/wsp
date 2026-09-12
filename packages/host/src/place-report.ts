// SPDX-License-Identifier: AGPL-3.0-only
// What a computer joined as a place says about itself, where it keeps the two
// files that say which wsp it belongs to, and the sweep that takes wsp off it.
// It sits apart from the agent that holds the link because the agent reaches
// @wsp/daemon, which dlopens node-pty at import: nothing that merely imports
// @wsp/host may load that, and these three readings are wanted on the host
// side too, where the places list reads this computer's own row.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { homedir, arch as osArch, platform, release, type as osType, userInfo } from "node:os";
import type { PlaceSelfReport } from "@wsp/daemon";
import { PLACE_FILE_MODE, parsePlaceFile, placeFileText, type PlaceFile } from "@wsp/protocol";
import { LOGIN_READ, SSH_STORE_VARS, isPlainPath, localShape, plainPath, readValues } from "@wsp/engine";
import { DAEMON_VERSION, placeDaemonPaths, workFolderIn } from "@wsp/protocol";
import { dirname } from "node:path";
import { daemonOwnedPaths, sshDaemonPlace } from "./doctor.js";
import { mcpServerCommand, onPath, runningWsp, type RunningWsp } from "./mcp-install.js";
import { serviceManagerFor, systemRunner, type ServiceAddress, type ServiceManager, type ServiceRunner } from "./service.js";

/** Where a place keeps the file naming the wsp it belongs to, and the private key it proves itself with. Both sit
 * in wsp's own folder under the person's home, beside the daemon's own files, so a leave takes one folder's worth. */
export const placeFilePath = (home: string): string => `${placeDaemonPaths(home).wsp}/place.json`;
export const placeKeyPath = (home: string): string => `${placeDaemonPaths(home).wsp}/place-key.pem`;

/** Where the agent's output goes, since nobody is watching a terminal: wsp's own folder under the person's home,
 * beside everything else the agent keeps, so the sweep takes it with the rest. */
export const placeLogPath = (home: string): string => `${placeDaemonPaths(home).wsp}/place.log`;

/** The place file as it stands, or nothing when this computer is no place. The shape, the parse and the mode are
 * the protocol's; this is the read on the host's side of the wire.
 *
 * The other copy of these two lines is `readPlaceFile` and `writePlaceFile` in `packages/daemon/src/link.ts`, which
 * is the agent's own. The boundary that forces it: nothing here may import that package eagerly, because its module
 * scope dlopens a native pty, and the protocol, which both sides do import, is bundled into the browser and can
 * hold no fs call. What could drift is in the protocol; what is copied is the read and the write of a file. */
export function readPlaceFile(path: string): PlaceFile | undefined {
  try {
    return parsePlaceFile(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Writes it at the one mode it is ever kept at; the folder is made first, since a fresh computer has none. */
export function writePlaceFile(path: string, file: PlaceFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, placeFileText(file), { mode: PLACE_FILE_MODE });
  chmodSync(path, PLACE_FILE_MODE);
}

/** The line that runs this same wsp again on this computer, word by word, for the tools a turn's agent is given
 * later. The one rule an agent's own config is written from, with the verb off the end since the caller names its
 * own: mcpServerCommand always puts it last. */
export function wspArgvOf(run: RunningWsp = runningWsp()): string[] {
  const { command, args } = mcpServerCommand(run);
  return [command, ...args.slice(0, -1)];
}

/** How much room is left on the volume the work folder sits on, or nothing when this computer will not say. It is
 * the one number a person asks about before they send a long job to a laptop. */
function diskFree(folder: string): number | undefined {
  try {
    const fs = statfsSync(folder);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return undefined;
  }
}

/** The login a turn on this computer runs under, as the ssh read records one: where the home is, who a turn runs
 * as, the PATH a login shell here gives, and the folder each harness keeps its own sessions in where the person
 * points it somewhere. Every path is held to the rule every machine's home is held to, since what is here lands in
 * the commands the host runs on this computer. */
export function placeLogin(env: Readonly<Record<string, string | undefined>> = process.env, home = homedir()): Record<string, string> {
  // A login shell, and the same read a machine over ssh answers: the PATH a turn runs under here is the one this
  // person's own shell gives, not the one the shell that typed wsp join happened to hold. The agent runs under a
  // service with almost no environment, so reading its own would leave every tool they installed unfindable.
  // HOME is handed in whatever this process holds: a service starts with almost none, and a login shell with no HOME
  // reads no login file of theirs at all, so the read would answer the service's own PATH and call it the person's.
  const values = loginShellRead({ ...env, HOME: home });
  const stores: Record<string, string> = {};
  for (const name of SSH_STORE_VARS) {
    const folder = values[`store:${name}`] ?? env[name];
    if (folder !== undefined && folder !== "" && isPlainPath(folder)) stores[name] = folder;
  }
  return { ...stores, HOME: home, USER: userInfo().username, PATH: plainPath(values["path"] ?? env.PATH) };
}

/** One login shell on this computer for what it answers about itself, or nothing when the shell would not run: a
 * computer without bash falls back to the environment this process holds, which is what it always had.
 *
 * By its own path and not by name: the whole point of the read is that the PATH this process holds is not the one a
 * turn wants, so looking the shell up on that PATH would be reading the answer to find the question. */
const LOGIN_SHELL = "/bin/bash";

function loginShellRead(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  try {
    return readValues(execFileSync(LOGIN_SHELL, ["-lc", LOGIN_READ], { encoding: "utf8", timeout: LOGIN_READ_MS, env: env as NodeJS.ProcessEnv }));
  } catch {
    return {};
  }
}

/** How long that shell gets. A person's login file can be slow; a report that waits on it forever is a link that
 * never dials. */
const LOGIN_READ_MS = 10_000;

export interface PlaceReportOptions {
  /** The name the host knows this computer by: what the place file holds, which is what wsp join was given or this
   * computer's own name lowercased. */
  name: string;
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  run?: RunningWsp;
  /** Whether this computer can fork, as the agent found out by asking the backend it offers rather than by looking
   * for a command on the PATH. The agent hands in that answer so the report and the backend it serves on the link
   * cannot disagree, and it stands for that agent's life: a computer that gains a Docker says so at the next start
   * of the agent, not at the next dial. Absent leaves the PATH read, which is what a report taken outside the
   * agent has. */
  docker?: boolean;
}

/** What this computer says about itself on every link. Read at each dial rather than once: a laptop gains a Docker,
 * loses a disk and is upgraded under wsp rather than by it. */
export function placeReport(opts: PlaceReportOptions): PlaceSelfReport {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const work = workFolderIn(home);
  const free = diskFree(existsSync(work) ? work : home);
  return {
    name: opts.name,
    platform: platform() === "darwin" ? "darwin" : "linux",
    arch: osArch(),
    os: `${osType()} ${release()}`,
    shape: localShape(),
    ...(free !== undefined ? { diskFreeBytes: free } : {}),
    login: placeLogin(env, home),
    // Whether this computer can fork at all, which is the one thing the host cannot read from over the link.
    docker: opts.docker ?? onPath("docker", env.PATH) !== undefined,
    daemonVersion: DAEMON_VERSION,
    wsp: wspArgvOf(opts.run ?? runningWsp()),
  };
}

/** What a sweep took off this computer, and what it left. */
export interface PlaceSweep {
  removed: string[];
  kept: string[];
}

/** The person's own work, which a leave never touches: the folder their turns ran in is theirs, and a place that
 * left a wsp keeps the files its threads wrote. */
export const placeKeptLine = (folder: string): string => `${folder} stays: the work your threads did there is yours`;

export interface PlaceSweepOptions {
  home?: string;
  /** Which manager holds the place's unit; this computer's own unless a caller hands another, and a caller that
   * means none (a computer wsp writes no unit for) hands undefined on purpose. */
  manager?: ServiceManager | undefined;
  run?: ServiceRunner;
  uid?: number;
}

/** Which service the agent on this computer is, for the manager that holds it. */
const placeService = (home: string, uid?: number): ServiceAddress => ({ role: "place", statePath: placeFilePath(home), home, uid: uid ?? process.getuid?.() ?? 0 });

/** Takes wsp off this computer: the file that holds the agent up, the place file and the key, and every path the
 * daemon and the installer put under wsp's own folder here, read off the one list the ssh road's removal reads so
 * nothing is named twice and nothing is guessed. The work folder stays, and the line says so.
 *
 * It does not ask the manager to stop anything, and that is the whole of the order here: on the road the host asks
 * for, the process running this sweep IS the agent, and a manager told to stop it kills it before it can answer.
 * The unit file goes first, so nothing brings the agent back at the next login however this ends; stopPlaceService
 * is the line that stops what is running, and its caller runs it once it has nothing left to say.
 *
 * Nothing here fails the leave: a manager that will not answer leaves its own line unsaid and the files still go,
 * since a person running this has already decided this computer is out of that wsp. */
export async function sweepPlace(opts: PlaceSweepOptions = {}): Promise<PlaceSweep> {
  const home = opts.home ?? homedir();
  const manager = opts.manager === undefined ? serviceManagerFor(platform()) : opts.manager;
  const at = placeDaemonPaths(home);
  const removed: string[] = [];
  if (manager !== undefined) {
    const address = placeService(home, opts.uid);
    const run = opts.run ?? systemRunner;
    // The manager forgets it at the next login first, while the unit file it reads that off is still there; then the
    // file goes. Either way round the service keeps running, which is what lets the sweep answer before it stops.
    for (const argv of manager.forget?.(address) ?? []) await run(argv);
    const unit = manager.unit(address);
    if (existsSync(unit.path)) {
      rmSync(unit.path, { force: true });
      removed.push(`${manager.words} ${unit.name}`);
    }
  }
  // The daemon on this computer is this process, so there is no second unit of its own; the paths below are the
  // ones the daemon writes and the ones an installer over ssh put there, which on a computer that was joined by
  // hand simply are not present.
  const owned = [
    placeFilePath(home),
    placeKeyPath(home),
    placeLogPath(home),
    ...daemonOwnedPaths(sshDaemonPlace({ home, path: "" })),
    `${at.binDir}/wsp-open`,
    `${at.binDir}/xdg-open`,
  ];
  for (const path of owned) {
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  return { removed, kept: [placeKeptLine(workFolderIn(home))] };
}

/** Asks this computer's manager to stop the agent, once the caller has nothing left to say: on the host's own road
 * this stops the very process that ran the sweep, so nothing after it is guaranteed to run. Its file and whatever
 * the manager held beside it are already gone by then, so no login brings it back. */
export async function stopPlaceService(opts: PlaceSweepOptions = {}): Promise<void> {
  const home = opts.home ?? homedir();
  const manager = opts.manager === undefined ? serviceManagerFor(platform()) : opts.manager;
  if (manager === undefined) return;
  const run = opts.run ?? systemRunner;
  for (const argv of manager.unload(placeService(home, opts.uid))) await run(argv);
}
