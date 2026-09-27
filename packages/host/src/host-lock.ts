// SPDX-License-Identifier: AGPL-3.0-only
// One state file, one host: the lock names the process serving it and the
// port it bound, so a second host refuses and other local tools find it.
import { existsSync, linkSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { authority, isWildcard, LOOPBACK, relayUrlOf, WS_PATH, type HostShape } from "@wsp/protocol";
import { ownFolder } from "@wsp/own-file";
import type { HostStarter } from "./host-start.js";

export interface HostLock {
  pid: number;
  port: number;
  /** The address the host bound, absent on a lock a host of an earlier build wrote, which bound this computer alone. */
  address?: string;
  startedAt: string;
  /** What brought this host up, where wsp brought it up itself: a verb that needed one, the wsp up a person typed,
   * or this computer's own manager holding the unit for the state file. wsp down stops any of them, and a second
   * wsp up is told so. Absent is a host a process serves inside itself, which nothing here may stop. */
  startedBy?: HostStarted;
}

/** The three roads a host is started by, as the lock records them: two a person's command line takes, and the
 * service this computer's own manager holds. */
export type HostStarted = HostShape;

/** The variable a host something else started carries. A verb's own child and the service's unit each mark the
 * host they start, so wsp down tells them from a host a person is holding open in a terminal, and a client tells
 * the service's own host from one it would be starting beside it. */
export const STARTED_BY_ENV = "WSP_STARTED_BY";

/** The roads that mark the host they start; the wsp up a person typed is read off the line, not the environment. */
const MARKS: readonly HostStarted[] = ["verb", "service"];

/** What the environment says started this process, and nothing where nothing did. */
export const startedByEnv = (env: Readonly<Record<string, string | undefined>>): HostStarted | undefined => MARKS.find(word => word === env[STARTED_BY_ENV]);

/** How often a wait on a host coming up or going down on this computer reads the lock again. */
export const POLL_MS = 200;

/** A load, a stop or a start is a process coming up or going down on this computer, not a network call. One number
 * for every road that waits on one, so a service, a verb's own child and a line waiting out a restart are given the
 * same patience. */
export const SERVICE_WAIT_MS = 20_000;

function isHostLock(v: unknown): v is HostLock {
  return (
    typeof v === "object" &&
    v !== null &&
    "pid" in v &&
    typeof v.pid === "number" &&
    "port" in v &&
    typeof v.port === "number" &&
    "startedAt" in v &&
    typeof v.startedAt === "string"
  );
}

function errnoCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

/** What signal 0 says about a pid, read once here so the two readings below cannot drift: this login's own
 * process, a process of another login (EPERM), or no process at all. */
function signalled(pid: number): "own" | "another" | "gone" {
  try {
    process.kill(pid, 0);
    return "own";
  } catch (e) {
    return errnoCode(e) === "EPERM" ? "another" : "gone";
  }
}

/** Whether a pid is a live process, whoever owns it: a lock another login holds is still a held lock, and a
 * second host on the same state file gives way to it. */
export const pidAlive = (pid: number): boolean => signalled(pid) !== "gone";

/** Whether a pid is a process this login could signal, which is a process of its own. A lock naming a pid that
 * answers EPERM names another login's process on a number a dead host once had, which is the stale lock case. */
export const ownPid = (pid: number): boolean => signalled(pid) === "own";

function readLock(path: string): HostLock | undefined {
  const text = readText(path);
  return text === undefined ? undefined : lockOf(text);
}

function readText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function lockOf(text: string): HostLock | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isHostLock(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function heldBy(lock: HostLock, statePath: string): Error {
  return new Error(
    `another wsp host (pid ${lock.pid}) is already serving ${statePath} on port ${lock.port}. ` +
      (lock.startedBy !== undefined ? "wsp down stops it, or point --state at a different file." : "Stop it first, or point --state at a different file."),
  );
}

export function lockPathFor(statePath: string): string {
  return join(dirname(statePath), "host.lock");
}

/** Where the host writes the token its protocol socket takes, for the other local tools that dial it. */
export function hostTokenPath(statePath: string): string {
  return join(dirname(statePath), "host-token");
}

/** What the host serving this state file presents on its own socket, as every tool on this computer reads it: the
 * token file beside the state, or nothing when no host has written one. */
export function hostTokenFor(statePath: string): string | undefined {
  try {
    return readFileSync(hostTokenPath(statePath), "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Where the runs a turn on this computer leaves live, beside the lock and the token: the script, the log, the pid
 * and the exit code of every turn this host launched here. One folder per state file, so a host that comes back
 * finds its own turns still running and two hosts on this computer never sweep each other's. */
export function hostRunDir(statePath: string): string {
  return join(dirname(statePath), "runs");
}

/** Where this host's own workspace keeps the folders its daemon may browse, beside the lock and the runs. The
 * person's home is what that daemon browses from, and this file says which folders under it are a project's; it
 * belongs to the host serving this state file, so two hosts on two state files write two of them rather than
 * rewriting one another's. */
export function hostRootsPath(statePath: string): string {
  return join(dirname(statePath), "roots");
}

/** Where the files handed to a turn on this computer land for its daemon to pick up, beside the lock and the runs,
 * under the same rule: one per state file, made by the host that serves it. */
export function hostInboxDir(statePath: string): string {
  return join(dirname(statePath), "inbox");
}

/** Where a host nobody is watching writes what a terminal run would have shown, beside the lock and the token. */
export function hostLogPath(statePath: string): string {
  return join(dirname(statePath), "host.log");
}

/** Where the host serving this state file is, as it prints them when it starts and as wsp status prints them while
 * it runs: one rule for the lines, so both readings name the same ports, the same address and the same token file.
 * A reading with no address is a host that bound this computer alone. The bound address and the public one stay
 * apart, since they are two roads in and not two spellings of one: the first is the object the lock and the init
 * hand-over both carry, and the second is a name a relay gave this host, which only a caller that read the relay
 * record can know. */
export function addressLines(statePath: string, at: { port: number; address?: string }, publicHostname?: string): string[] {
  const bound = at.address ?? LOOPBACK;
  return [
    `app         http://${authority(bound, at.port)}`,
    `runtime ws  ws://${authority(bound, at.port)}${WS_PATH} (token: ${hostTokenPath(statePath)})`,
    stateLine(statePath),
    ...(publicHostname !== undefined ? [publicAddressLine(publicHostname)] : []),
  ];
}

/** The one line naming the state a run works on, wherever a summary names it: the host's own start lines, wsp
 * status and the relay link all read it here, so a person comparing two readings compares the same spelling. */
export function stateLine(statePath: string): string {
  return `state       ${statePath}`;
}

/** The one line naming where this host answers from anywhere: printed at start when the relay already had a name
 * for it, and again by whatever learns the name later, so both readings are the same sentence. */
export function publicAddressLine(hostname: string): string {
  return `public      ${relayUrlOf(hostname)}`;
}

/** Where a tool on this computer dials the host serving this state file: the address the host bound, and loopback
 * only for the wildcard, which is the one address that is not itself a place to dial. Every other spelling is
 * passed through as it was given, since a host on ::1 or on 127.0.0.2 answers there and nowhere else. */
export function dialAddress(lock: { address?: string }): string {
  const at = lock.address ?? LOOPBACK;
  return isWildcard(at) ? LOOPBACK : at;
}

/** The host whose lock names this state file, when that process is still alive. */
export function servingHost(statePath: string): HostLock | undefined {
  const held = readLock(lockPathFor(statePath));
  return held !== undefined && pidAlive(held.pid) ? held : undefined;
}

/** The host serving this state file here, started first when none does and the line was handed a starter; nothing
 * where none serves and nothing may start one. Only for a line aimed at this computer: a host elsewhere is not
 * this computer's to start. */
export async function heldOrStarted(statePath: string, start: HostStarter | undefined, say: (line: string) => void): Promise<HostLock | undefined> {
  return servingHost(statePath) ?? (await start?.(statePath, say));
}

/** One state file, one host. A lock whose pid is gone is a crash leftover and
 * gives way; a lock this process cannot parse is treated the same. Read twice
 * on the road a start takes: once before it picks ports or builds anything, so
 * a host already serving costs the second start nothing, and again in takeLock
 * where a lock already stands in the place its link wanted. */
export function refuseIfServed(lockPath: string, statePath: string): void {
  const held = readLock(lockPath);
  if (held !== undefined && pidAlive(held.pid)) throw heldBy(held, statePath);
}

/** Seeded with the requested port so a refusal during startup can name it;
 * rewritten with the bound port once the host is up. A lock only ever appears
 * whole: it is written to a file of this process's own and linked into place,
 * which fails where any lock stands, so of starts at once only one gets past
 * here and the others never reach the token. */
export function takeLock(lockPath: string, statePath: string, ports: { port: number; address?: string; startedBy?: HostStarted }): HostLock {
  refuseIfServed(lockPath, statePath);
  const lock: HostLock = { pid: process.pid, ...ports, startedAt: new Date().toISOString() };
  // The state file, its blobs and the host token sit here, so the folder is the owner's before the lock is taken.
  ownFolder(dirname(statePath));
  ownFolder(dirname(lockPath));
  const mine = `${lockPath}.${process.pid}`;
  writeFileSync(mine, JSON.stringify(lock));
  try {
    if (!linkInto(mine, lockPath)) takeOverStale(lockPath, statePath, mine);
  } finally {
    rmSync(mine, { force: true });
  }
  // With a live lock standing no marker's holder may remove it, since its text is not the stale one any of them read,
  // so every marker goes, and each marker's words a crash left beside it.
  const base = basename(lockPath);
  for (const name of readdirSync(dirname(lockPath))) {
    const left = /^(\d+)\.taking$/.exec(name.slice(base.length + 1));
    if (name.startsWith(`${base}.taking.`) || (name.startsWith(`${base}.`) && left !== null && !pidAlive(Number(left[1])))) rmSync(join(dirname(lockPath), name), { force: true });
  }
  return lock;
}

/** How long a take-over marker that names no pid stands before it is read as a crash's: a take-over is a few file
 * calls. A marker that names a pid stands for as long as that pid lives, however long, since a pid handed out again
 * costs a refusal and a live holder read as gone would cost two hosts. */
export const MARKER_MS = 10_000;

/** Takes over the stale lock standing at the path, one start at a time: the one that holds the marker, and only
 * while the lock is still the one it read. Only a marker's holder removes a lock, and only that one, so a live lock
 * is never moved and the path stands empty only in the moment before the holder links its own, where a start that
 * links first wins and the holder refuses. */
function takeOverStale(lockPath: string, statePath: string, mine: string): void {
  const stale = readText(lockPath);
  if (stale !== undefined) {
    const held = lockOf(stale);
    if (held !== undefined && pidAlive(held.pid)) throw heldBy(held, statePath);
    const marker = holdMarker(lockPath, statePath);
    try {
      const now = readText(lockPath);
      if (now !== undefined && now !== stale) throw tookFirst(lockPath, statePath);
      rmSync(lockPath, { force: true });
      if (!linkInto(mine, lockPath)) throw tookFirst(lockPath, statePath);
    } finally {
      rmSync(marker, { force: true });
    }
  } else if (!linkInto(mine, lockPath)) throw tookFirst(lockPath, statePath);
}

/** The first take-over marker nobody live holds, linked whole as the lock is. A start that finds one abandoned never
 * removes it (only the sweep does, once a live lock stands), so two starts that both find it race for the next one and
 * only one gets it. */
function holdMarker(lockPath: string, statePath: string): string {
  const text = `${lockPath}.${process.pid}.taking`;
  writeFileSync(text, JSON.stringify({ pid: process.pid }));
  try {
    for (let n = 0; ; n++) {
      const marker = `${lockPath}.taking.${n}`;
      if (linkInto(text, marker)) return marker;
      const holder = markerHolder(marker);
      if (holder !== undefined) throw new Error(`another wsp host${typeof holder === "number" ? ` (pid ${holder})` : ""} is starting on ${statePath} right now; it serves in a moment.`);
    }
  } finally {
    rmSync(text, { force: true });
  }
}

/** The live start a marker is held by, or nothing where it is a crash's: its pid gone. One that names no pid yet is a
 * start still writing it, on a file system that creates before it writes, until it is older than MARKER_MS. */
function markerHolder(marker: string): number | "unknown" | undefined {
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(marker, "utf8")) as { pid?: unknown }).pid;
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return undefined;
  }
  if (typeof pid === "number") return pidAlive(pid) ? pid : undefined;
  try {
    return Date.now() - statSync(marker).mtimeMs > MARKER_MS ? undefined : "unknown";
  } catch {
    return undefined;
  }
}

function tookFirst(lockPath: string, statePath: string): Error {
  const winner = readLock(lockPath);
  return winner !== undefined ? heldBy(winner, statePath) : new Error(`another wsp host just took ${lockPath}`);
}

/** The lock rewritten by the host holding it, swapped in whole, so a start reading it never meets half a file and
 * takes it for a stale one. */
export function rewriteLock(lockPath: string, lock: HostLock): void {
  const next = `${lockPath}.${process.pid}`;
  writeFileSync(next, JSON.stringify(lock));
  renameSync(next, lockPath);
}

/** What link() says on a file system with no hard links: exFAT, and some network mounts. */
const NO_LINKS = new Set(["EPERM", "ENOTSUP", "EXDEV"]);

/** Links a whole lock into place; false where a lock already stands. A file system with no hard links gets the
 * exclusive create instead, so a state file kept on one still starts, with the moment between the file appearing
 * and its words landing that the create has. */
function linkInto(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    return true;
  } catch (e) {
    if (errnoCode(e) === "EEXIST") return false;
    if (!NO_LINKS.has(errnoCode(e) ?? "")) throw e;
  }
  try {
    writeFileSync(to, readFileSync(from), { flag: "wx" });
    return true;
  } catch (e) {
    if (errnoCode(e) === "EEXIST") return false;
    throw e;
  }
}
