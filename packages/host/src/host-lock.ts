// SPDX-License-Identifier: AGPL-3.0-only
// One state file, one host: the lock names the process serving it and the
// ports it bound, so a second host refuses and other local tools find it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authority, isWildcard, LOOPBACK, relayUrlOf } from "@wsp/protocol";

export interface HostLock {
  pid: number;
  port: number;
  wsPort: number;
  /** The address the host bound, absent on a lock a host of an earlier build wrote, which bound this computer alone. */
  address?: string;
  startedAt: string;
  /** Set when a verb started this host for itself rather than a person typing wsp up: wsp down stops such a host,
   * and a second wsp up is told so. Absent means somebody is holding it open. */
  startedBy?: "verb";
}

function isHostLock(v: unknown): v is HostLock {
  return (
    typeof v === "object" &&
    v !== null &&
    "pid" in v &&
    typeof v.pid === "number" &&
    "port" in v &&
    typeof v.port === "number" &&
    "wsPort" in v &&
    typeof v.wsPort === "number" &&
    "startedAt" in v &&
    typeof v.startedAt === "string"
  );
}

function errnoCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

/** EPERM means the pid exists under another user, so it counts as alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === "EPERM";
  }
}

function readLock(path: string): HostLock | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isHostLock(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function heldBy(lock: HostLock, statePath: string): Error {
  return new Error(
    `another wsp host (pid ${lock.pid}) is already serving ${statePath} on port ${lock.port} (ws ${lock.wsPort}). ` +
      (lock.startedBy === "verb" ? "wsp down stops it, or point --state at a different file." : "Stop it first, or point --state at a different file."),
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
export function addressLines(statePath: string, at: { port: number; wsPort: number; address?: string }, publicHostname?: string): string[] {
  const bound = at.address ?? LOOPBACK;
  return [
    `app         http://${authority(bound, at.port)}`,
    `runtime ws  ws://${authority(bound, at.wsPort)} (token: ${hostTokenPath(statePath)})`,
    `state       ${statePath}`,
    ...(publicHostname !== undefined ? [publicAddressLine(publicHostname)] : []),
  ];
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

/** One state file, one host. A lock whose pid is gone is a crash leftover and
 * gives way; a lock this process cannot parse is treated the same. */
function refuseIfServed(lockPath: string, statePath: string): void {
  const held = readLock(lockPath);
  if (held !== undefined && pidAlive(held.pid)) throw heldBy(held, statePath);
}

/** Seeded with the requested ports so a refusal during startup can name them;
 * rewritten with the bound ports once the host is up. */
export function takeLock(lockPath: string, statePath: string, ports: { port: number; wsPort: number; address?: string; startedBy?: "verb" }): HostLock {
  refuseIfServed(lockPath, statePath);
  const lock: HostLock = { pid: process.pid, ...ports, startedAt: new Date().toISOString() };
  mkdirSync(dirname(lockPath), { recursive: true });
  rmSync(lockPath, { force: true });
  try {
    writeFileSync(lockPath, JSON.stringify(lock), { flag: "wx" });
  } catch (e) {
    if (errnoCode(e) !== "EEXIST") throw e;
    const winner = readLock(lockPath);
    throw winner !== undefined ? heldBy(winner, statePath) : new Error(`another wsp host just took ${lockPath}`);
  }
  return lock;
}
