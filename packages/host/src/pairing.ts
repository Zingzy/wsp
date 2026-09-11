// SPDX-License-Identifier: AGPL-3.0-only
// The two commands a person runs on the computer the host runs on to let
// another computer in and to take it back out. Both dial the host over
// loopback with the token it wrote beside its state file, so neither is a road
// a paired client or an agent can reach: a code hands out access, and only
// somebody at the host's own terminal hands it out.
import { networkInterfaces } from "node:os";
import { fmtDuration, isLoopback, LOOPBACK, usageRefusal, type DeviceView } from "@wsp/protocol";
import type { CliIO } from "./cli.js";
import { servingHost } from "./host-lock.js";
import { dialHost, table, type HostClient } from "./verbs.js";

/** Every address a client may dial the host at, given what it bound: the wildcard stands for each address this
 * computer answers on, and anything else is itself. Loopback is left in only when that is all the host bound, since
 * a person reading this from another computer needs an address that leaves this one. */
export function reachAddresses(bound: string, interfaces = networkInterfaces()): string[] {
  if (bound !== "0.0.0.0" && bound !== "::") return [bound];
  const found = Object.values(interfaces)
    .flatMap(rows => rows ?? [])
    .filter(row => !row.internal)
    .map(row => (row.family === "IPv6" ? `[${row.address}]` : row.address));
  return found.length === 0 ? [LOOPBACK] : [...new Set(found)];
}

/** What wsp pair prints: the code, how long it stands, and the addresses to hand the person at the other computer. */
export function pairLines(code: string, expiresAt: number, now: number, addresses: readonly string[], port: number): string[] {
  return [
    `code        ${code}`,
    `expires     in ${fmtDuration(Math.max(0, expiresAt - now))}, at ${new Date(expiresAt).toISOString()}`,
    ...addresses.map(at => `open        http://${at}:${port}`),
    "The code is spent by the first client that redeems it; wsp devices lists what took one.",
  ];
}

/** The rows wsp devices prints, oldest pairing first. */
export function deviceLines(devices: readonly DeviceView[]): string[] {
  if (devices.length === 0) return ["No computer is paired with this host. Run wsp pair for a code."];
  return table([["DEVICE", "ID", "PAIRED", "LAST SEEN"], ...devices.map(d => [d.name, d.id, d.createdAt, d.lastSeenAt ?? "never"])]);
}

/** The line a host that binds this computer alone answers wsp pair with: nothing outside can reach it, so a code
 * would open nothing. */
export function pairOnLoopbackLine(address: string): string {
  return `wsp pair: this host listens on ${address}, which no other computer can reach, so a pairing code would open nothing. Start it with wsp up --listen <address> first.`;
}

interface PairDeps {
  dial(statePath: string): Promise<HostClient>;
  now(): number;
}

const systemDeps: PairDeps = { dial: dialHost, now: Date.now };

export async function pairCommand(io: CliIO, opts: { statePath: string }, args: readonly string[], deps: PairDeps = systemDeps): Promise<number> {
  if (args.length !== 0) throw usageRefusal("wsp pair takes no positional arguments");
  const lock = servingHost(opts.statePath);
  const address = lock?.address ?? LOOPBACK;
  const client = await deps.dial(opts.statePath);
  try {
    const { code, expiresAt } = await client.request<{ code: string; expiresAt: number }>("pair.issue");
    if (isLoopback(address)) io.error(pairOnLoopbackLine(address));
    for (const line of pairLines(code, expiresAt, deps.now(), reachAddresses(address), lock?.port ?? 0)) io.log(line);
    return 0;
  } finally {
    client.close();
  }
}

export async function devicesCommand(io: CliIO, opts: { statePath: string }, args: readonly string[], deps: PairDeps = systemDeps): Promise<number> {
  const [word, id] = args;
  if (word !== undefined && (word !== "revoke" || id === undefined || args.length !== 2)) {
    throw usageRefusal("usage: wsp devices\n       wsp devices revoke <id>");
  }
  const client = await deps.dial(opts.statePath);
  try {
    if (word === "revoke") {
      const { revoked } = await client.request<{ revoked: boolean }>("devices.revoke", { deviceId: id });
      if (!revoked) {
        io.error(`wsp devices revoke: no device ${id!} is paired with this host.`);
        return 1;
      }
      io.log(`device ${id!} revoked; its token opens nothing and the sockets it held are cut`);
      return 0;
    }
    const { devices } = await client.request<{ devices: DeviceView[] }>("devices.list");
    for (const line of deviceLines(devices)) io.log(line);
    return 0;
  } finally {
    client.close();
  }
}
