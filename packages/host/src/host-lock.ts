// SPDX-License-Identifier: AGPL-3.0-only
// One state file, one host: the lock names the process serving it and the
// ports it bound, so a second host refuses and other local tools find it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LOOPBACK } from "@wsp/protocol";

export interface HostLock {
  pid: number;
  port: number;
  wsPort: number;
  /** The address the host bound, absent on a lock a host of an earlier build wrote, which bound this computer alone. */
  address?: string;
  startedAt: string;
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
      "Stop it first, or point --state at a different file.",
  );
}

export function lockPathFor(statePath: string): string {
  return join(dirname(statePath), "host.lock");
}

/** Where the host writes the token its protocol socket takes, for the other local tools that dial it. */
export function hostTokenPath(statePath: string): string {
  return join(dirname(statePath), "host-token");
}

/** Where a host nobody is watching writes what a terminal run would have shown, beside the lock and the token. */
export function hostLogPath(statePath: string): string {
  return join(dirname(statePath), "host.log");
}

/** Where the host serving this state file is, as it prints them when it starts and as wsp status prints them while
 * it runs: one rule for the three lines, so both readings name the same ports, the same address and the same token
 * file. A reading with no address is a host that bound this computer alone. */
export function addressLines(statePath: string, ports: { port: number; wsPort: number; address?: string }): string[] {
  const at = ports.address ?? LOOPBACK;
  return [
    `app         http://${at}:${ports.port}`,
    `runtime ws  ws://${at}:${ports.wsPort} (token: ${hostTokenPath(statePath)})`,
    `state       ${statePath}`,
  ];
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
export function takeLock(lockPath: string, statePath: string, ports: { port: number; wsPort: number; address?: string }): HostLock {
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
