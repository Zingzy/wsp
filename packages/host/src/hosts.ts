// SPDX-License-Identifier: AGPL-3.0-only
// The hosts this computer has been paired with, and the one rule that decides
// which host a line runs against. A record is one file per alias under the wsp
// home, mode 0600, holding the address and the device token a pairing code
// bought; the default alias is one word in a file beside them. Every reader
// of "which host" comes through aimedHost, so the command line and the tool
// server cannot disagree about where a verb goes.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WS_PATH, isUrl, usageRefusal, type HostRoad } from "@wsp/protocol";
import { servingHost } from "./host-lock.js";

/** The address predicate has one home in the protocol; the command line's callers read it from here. */
export { isUrl };

/** What this computer keeps about a host on another one: the address a person gave wsp connect, the device the host
 * minted for this computer and the token that names it. The token opens the host, so the file is the person's own. */
export interface HostRecord {
  url: string;
  deviceId: string;
  deviceToken: string;
  pairedAt: string;
  /** What the desktop shows for this host; the alias stands in when a record from the command line carries none. */
  label?: string;
  /** How the desktop reached it; a record the command line wrote carries none and is read as an address. */
  road?: HostRoad;
  /** The ssh login the desktop forwards through, and the port the host answers on over there. */
  ssh?: SshLogin;
}

/** Where the desktop logs in: the address as ssh takes it and the port when it is not ssh's own. The port the host
 * answers on over there is not kept: the box's lock says it, and the road reads the lock on every connection. */
export interface SshLogin {
  address: string;
  port?: number;
}

/** One connected host as wsp hosts prints it: never the token, which no listing has any use for. */
export interface HostEntry {
  alias: string;
  url: string;
  deviceId: string;
  default: boolean;
  label?: string;
  road?: HostRoad;
}

/** The home wsp keeps everything of a person's in when nobody names another. */
export const DEFAULT_HOME = join(homedir(), ".wsp");

/** The folder wsp keeps its state, its keys and its hosts in. One reading, since the command line, the verbs and the
 * tool server all have to name the same folder. */
export function wspHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env["WSP_HOME"] ?? DEFAULT_HOME;
}

export function hostsDir(home: string): string {
  return join(home, "hosts");
}

/** The file naming the alias every line takes when none names one. */
const defaultFile = (home: string): string => join(hostsDir(home), "default");

/** An alias is one name, never a path: it becomes a file name under the hosts folder, so a word with a separator or
 * a dot-dot in it is refused before anything is written or read. The characters, the one an alias may open with
 * and the length live here alone, since the name a person types and the name an address is folded into are held to
 * the same rule. */
const ALIAS_CHARS = "A-Za-z0-9._-";
const ALIAS_FIRST = "A-Za-z0-9";
const ALIAS_MAX = 64;
const ALIAS = new RegExp(`^[${ALIAS_FIRST}][${ALIAS_CHARS}]{0,${ALIAS_MAX - 1}}$`);

const aliasOk = (alias: string): boolean => ALIAS.test(alias) && !alias.includes("..");

/** The alias itself, or the refusal for a word that could never be one. Every road that writes a name reads it
 * here, and `wsp connect` reads it before the dial that spends a code, so a name it would refuse costs nothing. */
export function checkedAlias(alias: string): string {
  if (!aliasOk(alias)) throw usageRefusal(`${JSON.stringify(alias)} is not a host alias; a name is letters, digits, dots, dashes and underscores, opens with a letter or a digit, and is at most ${ALIAS_MAX} characters`);
  return alias;
}

/** The alias a name becomes when nobody typed one: what the rule above will not take folded to a dash, the
 * characters it cannot open with dropped, cut to the length it allows. */
export function aliasFrom(name: string): string {
  const folded = name
    .replace(new RegExp(`[^${ALIAS_CHARS}]`, "g"), "-")
    .replace(new RegExp(`^[^${ALIAS_FIRST}]+`), "")
    .slice(0, ALIAS_MAX);
  return folded === "" ? "host" : folded;
}

const isRecord = (v: unknown): v is HostRecord =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as HostRecord).url === "string" &&
  typeof (v as HostRecord).deviceId === "string" &&
  typeof (v as HostRecord).deviceToken === "string";

export function hostFile(home: string, alias: string): string {
  return join(hostsDir(home), `${checkedAlias(alias)}.json`);
}

/** The record under this alias, or nothing when this computer holds none: a name that could not be a file, a file
 * that is not there and a file somebody hand-edited into nonsense all read the same. */
export function readHost(home: string, alias: string): HostRecord | undefined {
  if (!aliasOk(alias)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(hostFile(home, alias), "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeHost(home: string, alias: string, record: HostRecord): void {
  const path = hostFile(home, alias);
  mkdirSync(hostsDir(home), { recursive: true, mode: 0o700 });
  // The token in here opens the host, so the file is written for this user alone rather than left at the umask's word.
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function listHosts(home: string): HostEntry[] {
  const dir = hostsDir(home);
  if (!existsSync(dir)) return [];
  const marked = defaultHost(home);
  return readdirSync(dir)
    .filter(name => name.endsWith(".json"))
    .map(name => ({ alias: name.slice(0, -".json".length), record: readHost(home, name.slice(0, -".json".length)) }))
    .filter((h): h is { alias: string; record: HostRecord } => h.record !== undefined)
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map(h => ({
      alias: h.alias,
      url: h.record.url,
      deviceId: h.record.deviceId,
      default: h.alias === marked,
      ...(h.record.label !== undefined ? { label: h.record.label } : {}),
      ...(h.record.road !== undefined ? { road: h.record.road } : {}),
    }));
}

/** Takes the record away, and the default with it when it named this one. True when there was one to take. */
export function removeHost(home: string, alias: string): boolean {
  if (readHost(home, alias) === undefined) return false;
  // Read which alias is marked before the record goes: the mark is only a mark while the record it names is there,
  // so asking afterwards would leave the file behind pointing at a host this computer no longer holds.
  const marked = defaultHost(home);
  rmSync(hostFile(home, alias), { force: true });
  if (marked === alias) rmSync(defaultFile(home), { force: true });
  return true;
}

/** The alias every line takes when none names one, or nothing when the file is gone or names a host that is. */
export function defaultHost(home: string): string | undefined {
  let named: string;
  try {
    named = readFileSync(defaultFile(home), "utf8").trim();
  } catch {
    return undefined;
  }
  return named !== "" && readHost(home, named) !== undefined ? named : undefined;
}

export function setDefaultHost(home: string, alias: string): void {
  mkdirSync(hostsDir(home), { recursive: true, mode: 0o700 });
  writeFileSync(defaultFile(home), `${checkedAlias(alias)}\n`, { mode: 0o600 });
}

/** The WebSocket address of a host at this address: the same authority over ws or wss, with the runtime's path on
 * the end of whatever path the address already carries, which is what a tunnel hostname under a prefix needs. */
export function wsUrlOf(url: string): string {
  const parsed = new URL(url);
  const scheme = parsed.protocol === "https:" || parsed.protocol === "wss:" ? "wss:" : "ws:";
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${scheme}//${parsed.host}${path}${WS_PATH}`;
}

/** Which host a line runs against: the host on this computer, an alias this computer paired with, or an address
 * typed on the line, which carries no token and is only a road for wsp connect. */
export type HostAim = { kind: "here" } | { kind: "alias"; alias: string; record: HostRecord } | { kind: "url"; url: string };

/** What a caller names when it asks where to dial: the word a --host flag carried, the environment the caller runs
 * in, and the wsp home holding the hosts folder, which that environment names when the caller does not. */
export interface HostPick {
  host?: string;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

/** What the person reads when a line names a host this computer never paired with. */
export function noSuchHostLine(alias: string, home: string): string {
  const known = listHosts(home).map(h => h.alias);
  const has = known.length === 0 ? "this computer is paired with none" : `this computer is paired with ${known.join(", ")}`;
  return `no host named ${alias} is connected; ${has}, and wsp connect <url> --code <code> adds one.`;
}

/** What the person reads when a line names an address where an alias goes. An address carries no token, and only
 * the redeem of a pairing code can make one, so every other verb wants the name that redeem gave the host. */
export function addressNotPairedLine(url: string): string {
  return `--host takes the name of a host this computer is paired with; ${url} is an address, so run wsp connect ${url} --code <code> with a code from wsp pair on it first.`;
}

/** What the person reads when a host answered the socket and refused the token this computer holds. */
export function deviceRefusedLine(alias: string, url: string): string {
  return `the host ${alias} refused this computer's token, which it has taken away; run wsp pair on ${url} and wsp connect ${url} --code <code> --name ${alias} to pair again.`;
}

/** What the person reads when a host did not answer at all. */
export function noAnswerLine(where: string, why: string): string {
  return `the host at ${where} did not answer: ${why}`;
}

/** The note a line naming both --state and a host somewhere else gets: the state file is this computer's, and a
 * host elsewhere serves its own. */
export function stateIgnoredLine(where: string): string {
  return `--state names a file on this computer and this line runs against ${where}, which serves its own, so it is not read.`;
}

/** The one reading of which host a line runs against: the flag, then WSP_HOST, then the default alias when no host
 * on this computer serves the state file, then that host. The command line and the tool server both come here, so
 * a verb and a tool started the same way go to the same host. */
export function aimedHost(statePath: string, pick: HostPick = {}): HostAim {
  const env = pick.env ?? process.env;
  const home = pick.home ?? wspHome(env);
  const named = [pick.host, env["WSP_HOST"]].map(w => w?.trim()).find(w => w !== undefined && w !== "");
  if (named !== undefined) return aimAt(named, home);
  if (servingHost(statePath) !== undefined) return { kind: "here" };
  const fallback = defaultHost(home);
  return fallback === undefined ? { kind: "here" } : aimAt(fallback, home);
}

function aimAt(named: string, home: string): HostAim {
  if (isUrl(named)) return { kind: "url", url: named };
  const record = readHost(home, named);
  if (record === undefined) throw usageRefusal(noSuchHostLine(named, home));
  return { kind: "alias", alias: named, record };
}

/** How a host is named in a line the person reads: the alias where there is one, the address otherwise. */
export function aimName(aim: HostAim): string {
  return aim.kind === "alias" ? aim.alias : aim.kind === "url" ? aim.url : "this computer";
}
