// SPDX-License-Identifier: AGPL-3.0-only
// The three commands that give this computer a host on another one: connect
// spends a pairing code for a device token of this computer's own, hosts says
// which hosts it holds and which one lines take by default, and disconnect
// hands a token back and forgets it. Nothing here prints a token: a listing
// that leaked one would open the host to whoever read the terminal.
import { hostname } from "node:os";
import { usageRefusal } from "@wsp/protocol";
import type { CliIO } from "./cli.js";
import { aliasFrom, checkedAlias, defaultHost, isUrl, listHosts, noSuchHostLine, readHost, removeHost, setDefaultHost, writeHost, type HostRecord } from "./hosts.js";
import { dialHost, table, type DialOpts, type HostClient } from "./verbs.js";

const CONNECT_USAGE = "usage: wsp connect <url> --code <code> [--name <alias>]";
const HOSTS_USAGE = "usage: wsp hosts\n       wsp hosts default <alias>";
const DISCONNECT_USAGE = "usage: wsp disconnect <alias>";

/** What the commands work on: the state file this computer's own host would serve, and the home holding the hosts
 * folder they read and write. */
export interface ConnectOpts {
  statePath: string;
  home: string;
}

interface ConnectDeps {
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
  now(): number;
  /** What the host calls this computer in its own listing; the person at that terminal reads it to know who paired. */
  deviceName(): string;
}

const systemDeps: ConnectDeps = { dial: dialHost, now: Date.now, deviceName: hostname };

/** The name a host takes when nobody gives it one: what its address calls it, held to the same rule as a name a
 * person types, which the hosts file owns. */
export const aliasFor = (url: string): string => aliasFrom(new URL(url).hostname);

/** What wsp connect prints: which host this computer now holds and where, never the token it holds it by. */
export function connectedLines(alias: string, record: HostRecord, madeDefault: boolean): string[] {
  return [
    `host        ${alias}`,
    `url         ${record.url}`,
    `device      ${record.deviceId}`,
    madeDefault
      ? `${alias} is now the host every wsp line runs against; --host or WSP_HOST names another.`
      : `Run a line against it with --host ${alias}, or make it the one every line takes with wsp hosts default ${alias}.`,
  ];
}

/** The rows wsp hosts prints, one per host this computer paired with, the default marked. */
export function hostLines(hosts: ReturnType<typeof listHosts>): string[] {
  if (hosts.length === 0) return ["This computer is connected to no host on another computer. Run wsp connect <url> --code <code> with a code from wsp pair on that computer."];
  return table([["ALIAS", "URL", "DEVICE", ""], ...hosts.map(h => [h.alias, h.url, h.deviceId, h.default ? "default" : ""])]);
}

export async function connectCommand(io: CliIO, opts: ConnectOpts, values: { code?: string; name?: string }, args: readonly string[], deps: ConnectDeps = systemDeps): Promise<number> {
  const url = args[0];
  if (url === undefined || args.length !== 1) throw usageRefusal(CONNECT_USAGE);
  if (!isUrl(url)) throw usageRefusal(`wsp connect takes the address the host is served at, starting http:// or https://, got ${JSON.stringify(url)}`);
  const code = values.code;
  if (code === undefined || code.trim() === "") throw usageRefusal(`wsp connect needs the code wsp pair printed on that computer: --code <code>\n\n${CONNECT_USAGE}`);
  // Checked before the dial, never after it: a code is spent the moment it is redeemed, and a name refused on the
  // way back would leave the host holding a device whose only token went nowhere.
  const alias = checkedAlias(values.name ?? aliasFor(url));
  if (readHost(opts.home, alias) !== undefined) {
    throw usageRefusal(`a host named ${alias} is already connected; wsp disconnect ${alias} first, or give this one another name with --name.`);
  }
  const client = await deps.dial(opts.statePath, { host: url, home: opts.home, env: {}, redeem: { code: code.trim(), name: deps.deviceName() } });
  let paired;
  try {
    paired = client.paired;
  } finally {
    client.close();
  }
  if (paired === undefined) throw new Error(`the host at ${url} answered the pairing code with no device token; it runs another version of wsp`);
  const record: HostRecord = { url: url.replace(/\/+$/, ""), deviceId: paired.deviceId, deviceToken: paired.deviceToken, pairedAt: new Date(deps.now()).toISOString() };
  writeHost(opts.home, alias, record);
  const madeDefault = defaultHost(opts.home) === undefined;
  if (madeDefault) setDefaultHost(opts.home, alias);
  for (const line of connectedLines(alias, record, madeDefault)) io.log(line);
  return 0;
}

export async function hostsCommand(io: CliIO, opts: ConnectOpts, args: readonly string[]): Promise<number> {
  const [word, alias] = args;
  if (word !== undefined && (word !== "default" || alias === undefined || args.length !== 2)) throw usageRefusal(HOSTS_USAGE);
  if (word === "default") {
    if (readHost(opts.home, alias!) === undefined) throw usageRefusal(noSuchHostLine(alias!, opts.home));
    setDefaultHost(opts.home, alias!);
    io.log(`${alias!} is now the host every wsp line runs against; --host or WSP_HOST names another.`);
    return 0;
  }
  for (const line of hostLines(listHosts(opts.home))) io.log(line);
  return 0;
}

export async function disconnectCommand(io: CliIO, opts: ConnectOpts, args: readonly string[], deps: ConnectDeps = systemDeps): Promise<number> {
  const alias = args[0];
  if (alias === undefined || args.length !== 1) throw usageRefusal(DISCONNECT_USAGE);
  const record = readHost(opts.home, alias);
  if (record === undefined) throw usageRefusal(noSuchHostLine(alias, opts.home));
  // The record goes whatever the host says: a host that is off, gone or unreachable must not leave this computer
  // holding a token it cannot use, and the line below says what is left to do over there.
  let refused: unknown;
  try {
    const client = await deps.dial(opts.statePath, { host: alias, home: opts.home, env: {} });
    try {
      await client.request("devices.revoke", { deviceId: record.deviceId });
    } finally {
      client.close();
    }
  } catch (e) {
    refused = e;
  }
  removeHost(opts.home, alias);
  io.log(`disconnected from ${alias}; this computer no longer holds a token for ${record.url}`);
  if (refused === undefined) return 0;
  // A host that refuses the token has already taken this device away, so there was nothing left to hand back; any
  // other answer leaves the device standing over there and the person is the only one who can say so.
  if ((refused as { kind?: unknown }).kind === "auth") io.log(`${alias} had already taken this computer's token away, so there was nothing to hand back`);
  else {
    io.error(refused instanceof Error ? refused.message : String(refused));
    io.error(`the host may still hold this computer as a device; run wsp devices revoke ${record.deviceId} on that computer.`);
  }
  return 0;
}
