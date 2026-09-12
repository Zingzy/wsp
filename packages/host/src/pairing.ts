// SPDX-License-Identifier: AGPL-3.0-only
// The two commands a person runs on the computer the host runs on to let
// another computer in and to take it back out. Both dial the host at the
// address its lock names, with the token it wrote beside its state file, so
// neither is a road a paired client or an agent can reach: a code hands out
// access, and only somebody at the host's own terminal hands it out.
import { networkInterfaces } from "node:os";
import { authority, fmtDuration, isLoopback, isWildcard, LOOPBACK, relayUrlOf, usageRefusal, type DeviceView } from "@wsp/protocol";
import type { HostReach } from "@wsp/runtime";
import type { CliIO } from "./cli.js";
import { servingHost } from "./host-lock.js";
import { aimName, aimedHost, hostSideOnlyFix, hostSideOnlyLine, type HostAim, type HostPick } from "./hosts.js";
import { publicHostname } from "./relay-link.js";
import { dialHost, table, type DialOpts, type HostClient } from "./verbs.js";

/** An address that only reaches the link it sits on: IPv6 fe80::/10, which no browser opens without a scope id,
 * and IPv4's own 169.254/16. Neither is an address to hand somebody at another computer. */
const LINK_LOCAL = /^(fe[89ab][0-9a-f]:|169\.254\.)/i;

/** Every address a client may dial the host at, given what it bound: the wildcard stands for each address this
 * computer answers on in the family that wildcard covers, and anything else is itself. Link-local addresses are
 * left out, and loopback is named only when the wildcard covered nothing else, since a person reading this from
 * another computer needs an address that leaves this one. */
export function reachAddresses(bound: string, interfaces = networkInterfaces()): string[] {
  if (!isWildcard(bound)) return [bound];
  // An IPv4 wildcard listens on no IPv6 address; the IPv6 one is dual stack, so it covers both families.
  const family = bound === "0.0.0.0" ? "IPv4" : undefined;
  const found = Object.values(interfaces)
    .flatMap(rows => rows ?? [])
    .filter(row => !row.internal && !LINK_LOCAL.test(row.address) && (family === undefined || row.family === family))
    .map(row => row.address);
  return found.length === 0 ? [LOOPBACK] : [...new Set(found)];
}

/** The address the person named with --advertise, as an address: one reading of a blank and of a trailing slash,
 * since the flag, the rule a turn is told by and the words spelled back into a service unit all ask the same
 * question. Nothing where they named none, or only spaces. */
export function advertiseWord(word: string | undefined): string | undefined {
  const said = word?.trim().replace(/\/+$/, "") ?? "";
  return said === "" ? undefined : said;
}

/** The address a machine dials this host at, the one rule for it: what the person named with --advertise, else the
 * address the host bound turned into a url, and for a wildcard the first address this computer answers on that
 * leaves it. Loopback is what is left when nothing else answers, which is a host no machine can reach; the runtime
 * hands out no token to a turn when it is told none, and this is what a person overrides with --advertise. */
export function advertisedUrl(bound: string, port: number, asked?: string, interfaces = networkInterfaces()): string | undefined {
  const named = advertiseWord(asked);
  if (named !== undefined) return named;
  const at = reachAddresses(bound, interfaces)[0] ?? LOOPBACK;
  return isLoopback(at) ? undefined : `http://${authority(at, port)}`;
}

/** What a turn's launch is told about this host, for the kinds that need it. The address the person named with
 * --advertise stands above every kind's own answer; the address a machine somewhere else dials is the name a relay
 * carries this host under while a connector is holding it, since that one works from anywhere, else what this
 * computer answers on; and the port travels only where the host bound the wildcard. That last one is the whole
 * rule about a kind's own address: a host on the wildcard answers on every address this computer has, the ones a
 * machine knows of its own included, and a host bound to one address answers there and nowhere else, however a
 * machine would rather reach it. The url is read at each turn: a quick tunnel is given a new name every time its
 * connector runs. */
export function hostReach(
  at: { address: string; port: number },
  asked: string | undefined,
  publicAt: () => string | undefined,
  interfaces = networkInterfaces(),
): HostReach {
  const advertise = advertiseWord(asked);
  return {
    ...(advertise !== undefined ? { advertise } : {}),
    get url(): string | undefined {
      const relayed = publicAt();
      return relayed !== undefined ? relayUrlOf(relayed) : advertisedUrl(at.address, at.port, undefined, interfaces);
    },
    ...(isWildcard(at.address) ? { port: at.port } : {}),
  };
}

/** What wsp host pair prints: the code, how long it stands, and the addresses to hand the person at the other computer.
 * A host behind a relay leads with the address that works from anywhere, since that is the one to hand over. */
export function pairLines(code: string, expiresAt: number, now: number, addresses: readonly string[], port: number, publicAt?: string): string[] {
  return [
    `code        ${code}`,
    `expires     in ${fmtDuration(Math.max(0, expiresAt - now))}, at ${new Date(expiresAt).toISOString()}`,
    ...(publicAt !== undefined ? [`open        ${relayUrlOf(publicAt)}`] : []),
    ...addresses.map(at => `open        http://${authority(at, port)}`),
    "The code is spent by the first client that redeems it; wsp host devices lists what took one.",
  ];
}

/** The rows wsp host devices prints, oldest pairing first. */
export function deviceLines(devices: readonly DeviceView[]): string[] {
  if (devices.length === 0) return ["No computer is paired with this host. Run wsp host pair for a code."];
  return table([["DEVICE", "ID", "PAIRED", "LAST SEEN"], ...devices.map(d => [d.name, d.id, d.createdAt, d.lastSeenAt])]);
}

/** The line a host that binds this computer alone answers wsp host pair with: nothing outside can reach it, so a code
 * would open nothing. */
export function pairOnLoopbackLine(address: string): string {
  return `wsp host pair: this host listens on ${address}, which no other computer can reach, so a pairing code would open nothing. Start it with wsp up --listen <address> first.`;
}

interface PairDeps {
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
  now(): number;
}

const systemDeps: PairDeps = { dial: dialHost, now: Date.now };

/** What the two commands work on: the state file the host on this computer serves, and where this run would aim a
 * line, which is the flag it was given, the environment it runs in and the home holding the hosts folder. They read
 * the aim to refuse anywhere but here, and hand it to the dial so the hosts folder is read once and the dial cannot
 * fall back to a different environment than the refusal was decided from. */
export interface PairOpts extends HostPick {
  statePath: string;
}

function aimHere(word: string, opts: PairOpts): HostAim {
  const aim = aimedHost(opts.statePath, opts);
  if (aim.kind !== "here") throw usageRefusal(hostSideOnlyLine(word, aimName(aim)), hostSideOnlyFix());
  return aim;
}

export async function pairCommand(io: CliIO, opts: PairOpts, args: readonly string[], deps: PairDeps = systemDeps): Promise<number> {
  if (args.length !== 0) throw usageRefusal("wsp host pair takes no positional arguments.", "Run wsp host pair on its own; it prints the code and the line to type on the other computer.");
  const aim = aimHere("host pair", opts);
  const lock = servingHost(opts.statePath);
  const address = lock?.address ?? LOOPBACK;
  const client = await deps.dial(opts.statePath, { aim });
  try {
    const { code, expiresAt } = await client.request<{ code: string; expiresAt: number }>("pair.issue");
    // A relay is a road in of its own, so a host on loopback alone behind one is reachable and the warning would be wrong.
    const publicAt = publicHostname(opts.statePath);
    if (isLoopback(address) && publicAt === undefined) io.error(pairOnLoopbackLine(address));
    for (const line of pairLines(code, expiresAt, deps.now(), reachAddresses(address), lock?.port ?? 0, publicAt)) io.log(line);
    return 0;
  } finally {
    client.close();
  }
}

export async function devicesCommand(io: CliIO, opts: PairOpts, args: readonly string[], deps: PairDeps = systemDeps): Promise<number> {
  const [word, id] = args;
  if (word !== undefined && (word !== "revoke" || id === undefined || args.length !== 2)) {
    throw usageRefusal("wsp host devices takes nothing, or revoke and one device id.", "usage: wsp host devices\n       wsp host devices revoke <id>");
  }
  const aim = aimHere("host devices", opts);
  const client = await deps.dial(opts.statePath, { aim });
  try {
    if (word === "revoke") {
      const { revoked } = await client.request<{ revoked: boolean }>("devices.revoke", { deviceId: id });
      if (!revoked) {
        io.error(`wsp host devices revoke: no device ${id!} is paired with this host.`);
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
