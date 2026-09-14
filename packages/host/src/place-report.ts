// SPDX-License-Identifier: AGPL-3.0-only
// What a computer joined as a place says about itself, where it keeps the two
// files that say which wsp it belongs to, and the sweep that takes wsp off it.
// The daemon on the place builds its own report at every dial; this is the
// host's side, where the join's first frame and the places list read this
// computer's own row.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { homedir, arch as osArch, platform, release, type as osType, uptime as upSeconds, userInfo } from "node:os";
import { PLACE_FILE_MODE, engineWord, parsePlaceFile, placeFileText, workspacesBlockedBy, type PlaceEngine, type PlaceFile, type PlaceReport } from "@wsp/protocol";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { LOGIN_READ, SSH_STORE_VARS, isPlainPath, localShape, plainPath, readValues } from "@wsp/engine";
import { DAEMON_VERSION, placeDaemonPaths, placeOwnedPaths, workFolderIn } from "@wsp/protocol";
import { dirname } from "node:path";
import { profileSourceLine, sshDaemonPlace, type DaemonPlace } from "./doctor.js";
import { mcpServerCommand, onPath, runningWsp, type RunningWsp } from "./mcp-install.js";
import { runAll, runFailureLine, serviceManagerFor, STOP_WAIT_MS, systemRunner, type ServiceAddress, type ServiceManager, type ServiceRunner } from "./service.js";

/** Where a place keeps the file naming the wsp it belongs to, the private key it proves itself with, and the
 * agent's log, since nobody is watching a terminal. All three sit in wsp's own folder under the person's home,
 * beside the daemon's own files, so a leave takes one folder's worth; the protocol names them for both sides. */
export const placeFilePath = (home: string): string => placeDaemonPaths(home).placeFile;
export const placeKeyPath = (home: string): string => placeDaemonPaths(home).placeKey;
export const placeLogPath = (home: string): string => placeDaemonPaths(home).placeLog;

/** What a computer says about itself when it joins, before the host has named which address it dialed and which
 * port its daemon bound: the daemon fills those two in on every link. */
export type PlaceSelfReport = Omit<PlaceReport, "dialed" | "daemonPort">;

/** The place file as it stands, or nothing when this computer is no place. The shape, the parse and the mode are
 * the protocol's; this is the read on the host's side of the wire. */
export function readPlaceFile(path: string): PlaceFile | undefined {
  try {
    return parsePlaceFile(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Whether this computer already belongs to a wsp. The one reading of it: the join refuses on it and a screen that
 * has its own words for that reads the same thing rather than testing for the file a second time. */
export const joinedAlready = (home: string): boolean => readPlaceFile(placeFilePath(home)) !== undefined;

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
}

/** The engine a project's own containers would run on here, off the login PATH; the docker-first rule is the
 * protocol's, so the host and the node agent read it one way. */
function engineOnPath(path: string | undefined): PlaceEngine {
  return engineWord(onPath("docker", path) !== undefined, onPath("podman", path) !== undefined);
}

/** This computer's read-only reading of whether its daemon runs workspaces here, in the daemon's own words so the
 * host's own-machine row and a joined computer's report speak alike. The authoritative gate when a fork is asked
 * for is still the daemon's self check, which mounts an overlay and makes a cgroup; this reads the same kernel
 * facts without touching anything. `runs` overrides the read when the daemon already knows the answer. */
function selfDoctor(env: Readonly<Record<string, string | undefined>>): Pick<PlaceReport, "runsWorkspaces" | "engine"> & { workspacesBlocked?: string } {
  const engine = engineOnPath(env.PATH);
  const blocked = workspacesBlocked();
  return { runsWorkspaces: blocked === undefined, engine, ...(blocked === undefined ? {} : { workspacesBlocked: blocked }) };
}

/** The one kernel reason this computer cannot run workspaces, or nothing when it can: the protocol's rule over the
 * files this side reads. */
const workspacesBlocked = (): string | undefined => workspacesBlockedBy({ platform: platform(), read: readTextOr, euid: process.geteuid?.() });

/** A file's text, or nothing where it is not there, which is what the rule above reads absence as. */
function readTextOr(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** What this computer says about itself on every link. Read at each dial rather than once: a laptop gains an
 * engine, loses a disk and is upgraded under wsp rather than by it. */
export function placeReport(opts: PlaceReportOptions): PlaceSelfReport {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const work = workFolderIn(home);
  const free = diskFree(existsSync(work) ? work : home);
  const login = placeLogin(env, home);
  return {
    name: opts.name,
    platform: platform() === "darwin" ? "darwin" : "linux",
    arch: osArch(),
    os: `${osType()} ${release()}`,
    shape: localShape(),
    ...(free !== undefined ? { diskFreeBytes: free } : {}),
    login,
    // Whether the daemon runs workspaces here, and the engine a project's own containers would run on: the read-only
    // twin of the daemon's self check, so what the doctor says and what a create does cannot part ways.
    ...selfDoctor(env),
    uptimeMs: Math.max(0, Math.round(upSeconds() * 1000)),
    daemonVersion: DAEMON_VERSION,
    wsp: wspArgvOf(opts.run ?? runningWsp()),
    // Off the login PATH rather than this process's: a service starts with almost none, and what the person can
    // run here is what a turn on this computer will find.
    agents: CATALOG_AGENTS.filter(a => onPath(a.bin, login["PATH"]) !== undefined).map(a => a.id),
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

/** What a leave puts in front of each thing it took, and the one rule a host reading that leave back over ssh
 * tells those lines by. The sentences a person reads around them (which wsp this computer left, what stays, what
 * the host still has to be told) carry none, so the computer that prints them and the host that reads them back
 * tell the two apart the same way. */
const SWEPT_INDENT = "  ";
export const sweptLine = (took: string): string => `${SWEPT_INDENT}${took}`;

/** What a leave said it took, off everything that computer printed. Whatever else it said is a person's to read
 * at that terminal and no part of what came off. */
export const sweptSaid = (said: string): string[] =>
  said
    .split("\n")
    .filter(line => line.startsWith(SWEPT_INDENT) && line.trim() !== "")
    .map(line => line.trim());

export interface PlaceSweepOptions {
  home?: string;
  /** Which manager holds the place's unit; this computer's own unless a caller hands another, and a caller that
   * means none (a computer wsp writes no unit for) hands undefined on purpose. */
  manager?: ServiceManager | undefined;
  run?: ServiceRunner;
  uid?: number;
}

/** Which service the agent on this computer is, for the manager that holds it. Exported because the update road
 * names that unit from the host, and a second spelling of it there would be a second copy of the rule. */
export const placeService = (home: string, uid?: number): ServiceAddress => ({ role: "place", statePath: placeFilePath(home), home, uid: uid ?? process.getuid?.() ?? 0 });

/** Takes wsp off this computer: every file that holds the agent up, the place file and the key, and every path the
 * daemon and the installer put under wsp's own folder here, read off the one list the ssh road's removal reads so
 * nothing is named twice and nothing is guessed. The work folder stays, and the line says so.
 *
 * Every scope the manager could be holding a unit in, not only the one a join writes today: a computer joined
 * before the place's unit became the machine's own has its file under that login's systemd, and a sweep that read
 * one scope left that unit behind to come back under auto-restart with nothing to serve. Each line names the scope
 * it came out of and says what the manager answered when it was told to stop it, so a person reads which of the
 * two the leave took and whether anything of it is still running.
 *
 * The agent is stopped before its unit file goes, and the manager is reloaded after: a manager asked to stop a
 * unit whose file has already gone stops nothing, and the agent kept running with the place file and the log it
 * writes removed under it, until somebody restarted it by hand. This runs on the computer being left, where the
 * agent is another process from this one; the host's own road asks the agent to sweep itself over the link.
 *
 * Nothing here fails the leave: a manager that refuses says so in its own line, which carries what it answered
 * rather than the word the leave was after, and the files still go, since a person running this has already
 * decided this computer is out of that wsp. */
export async function sweepPlace(opts: PlaceSweepOptions = {}): Promise<PlaceSweep> {
  const home = opts.home ?? homedir();
  const manager = opts.manager === undefined ? serviceManagerFor(platform()) : opts.manager;
  const removed: string[] = [];
  if (manager !== undefined) {
    const address = placeService(home, opts.uid);
    const run = opts.run ?? systemRunner;
    for (const held of manager.held(address)) {
      // What is running goes first, then the link the manager would start it again by, both while the unit file
      // they name is still there; then the file, then the reload that leaves the manager holding nothing. Asked of
      // every scope whether a file is there or not: a scope can hold the link that enables a unit whose file has
      // already gone, and that link is what would start it again.
      const stopRefused = await runAll(held.stop, run, STOP_WAIT_MS);
      const forgetRefused = await runAll(held.forget, run);
      if (!existsSync(held.unit.path)) continue;
      rmSync(held.unit.path, { force: true });
      const reloadRefused = await runAll(held.reload, run);
      // What the manager answered, not what it was asked for: a stop that refused leaves the agent running, and a
      // line saying it was stopped would be the one thing a person reading a leave cannot check. The first refusal
      // of the three names its own command, so the line says which step it was.
      const refused = stopRefused ?? forgetRefused ?? reloadRefused;
      removed.push(`${held.words} ${held.unit.name} (${refused === undefined ? "stopped" : runFailureLine(refused)})`);
    }
  }
  // The daemon on this computer is this process, so there is no second unit of its own; the paths are the ones
  // the daemon writes and the ones an installer over ssh put there, which on a computer that was joined by hand
  // simply are not present.
  for (const path of placeOwnedPaths(home)) {
    // lstat, not exists: the browser name is a symlink to the shim beside it, and once the shim has gone the link
    // is dangling, which every following-the-link read calls absent while the person is still left holding it.
    if (!there(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
  const said = unsourced(sshDaemonPlace({ home, path: "" }));
  if (said !== undefined) removed.push(said);
  return { removed, kept: [placeKeptLine(workFolderIn(home))] };
}

/** Whether a path is there at all, link or file. */
function there(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Takes wsp's one line back out of the person's own login file, which would otherwise print an error at every
 * login for a file that is gone. Their file, so it is opened only when wsp's own line is in it and written back
 * through the same path rather than moved over: a .profile symlinked into a dotfiles checkout stays a symlink.
 * Answers what it says it took, or nothing when the file never held it. */
function unsourced(place: DaemonPlace): string | undefined {
  const file = place.profileSource;
  if (file === undefined || !there(file)) return undefined;
  const line = profileSourceLine(place.profileFile);
  let held: string;
  try {
    held = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const kept = held.split("\n").filter(row => row.trim() !== line);
  if (kept.length === held.split("\n").length) return undefined;
  writeFileSync(file, kept.join("\n"));
  return `${line} (out of ${file})`;
}
