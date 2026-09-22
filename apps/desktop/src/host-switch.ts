// SPDX-License-Identifier: AGPL-3.0-only
// The window moves between hosts. The app's own host is one session and every
// saved host another; whichever the window is on is what the origin gate on
// every bridge call reads, so a page from anywhere else is answered nothing.
// The hosts are the records wsp login writes off the account and wsp host
// connect writes for a code, read and written through the one module the
// command line uses, so wsp hosts and the Hosts menu are one list, less this
// computer's own record on the account, which the row for here is. The app's
// own host is never stopped by a move: a person who comes back finds it as
// they left it. A road to a host is one entry in ROADS: how it is opened the
// first time, how a saved one is reached again, and what it holds open;
// adding a road is its entry and nothing else here.
import { accountHosts, accountRecords, aimedHost, connectCommand, disconnectCommand, dialHost, aliasFrom, hostRoadWord, hostTokenFor, listHosts, noSuchHostLine, readHost, writeHost, type CliIO, type HostEntry, type HostRecord } from "@wsp/host";
import { HOST_WORDS, PAIR_CODE_LENGTH, PAIR_NO_KEY_REFUSAL, isUrl, readJoinToken, type HostConnectAsk, type HostOutcome, type HostRoad, type HostsView } from "@wsp/protocol";
import { portOf, remoteSession, type HostSession } from "./host-lifecycle.js";
import { forwardKey, type SshRoad } from "./ssh-road.js";

export interface SwitcherDeps {
  /** The app's own host, attached or started; the window opens on it and returns to it. */
  local: HostSession;
  /** The wsp home holding the hosts folder, the same one the command line reads. */
  home: string;
  /** This computer's state file, which the connect road names and never reads for a host elsewhere. */
  statePath: string;
  /** What this computer is called in the list. */
  here: string;
  /** Puts the window on a session, at the fragment the caller names; the page opens on what that fragment says. */
  load(session: HostSession, hash?: string): Promise<void>;
  log(line: string): void;
  connect?: typeof connectCommand;
  disconnect?: typeof disconnectCommand;
  dial?: typeof dialHost;
  ssh?: SshRoad;
}

export interface HostSwitcher {
  current(): HostSession;
  view(): HostsView;
  /** What the page opens the host the window is on with: the device token for a host somewhere else, and for the
   * host here its own token, which a page served beyond loopback carries no more than a relayed one does. */
  token(): string | undefined;
  /** Puts the window on a saved host, or on this computer for null, loaded at the fragment where one is named. */
  to(alias: string | null, hash?: string): Promise<HostOutcome>;
  connect(ask: HostConnectAsk): Promise<HostOutcome>;
  disconnect(alias: string): Promise<HostOutcome>;
  /** Closes what the roads hold open: the ssh forwards. */
  closeAll(): void;
}

type Refusal = Exclude<HostOutcome, { ok: true }>;
type FieldAt = Refusal["at"];

/** What a road hands back once it has a host to pair with: where to redeem the code, the code, and what the record
 * remembers of the road so a later launch can walk it again. */
interface Opened {
  url: string;
  code: string;
  alias: string;
  label: string;
  road: HostRoad;
  ssh?: HostRecord["ssh"];
}

/** A road that holds the ssh road, once the check said there is one. */
const sshRoadOf = (deps: SwitcherDeps): SshRoad => {
  if (deps.ssh === undefined) throw new Error(NO_SSH_LINE);
  return deps.ssh;
};

/** One road to a host, by kind. */
interface Road<A extends HostConnectAsk = HostConnectAsk> {
  /** A refusal the ask earns before anything is dialled, or nothing. */
  check(ask: A): Refusal | undefined;
  open(ask: A): Promise<Opened>;
  /** Where a saved host answers now; a road that holds something open (a forward) reopens it here. */
  reach(alias: string, record: HostRecord): Promise<string>;
  /** Which field a refusal after the check lands under. */
  at(e: unknown): FieldAt;
  /** What the road held open for this record, let go. */
  close(record: HostRecord): void;
}

const refuse = (q: string): Promise<string> => Promise.reject(new Error(`no terminal to ask: ${q}`));
const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isAuth = (e: unknown): boolean => (e as { kind?: unknown }).kind === "auth";
const failed = (at: FieldAt, e: unknown): Refusal => ({ ok: false, at, error: text(e) });

const ADDRESS_LINE = `the address starts with http:// or https://, like ${HOST_WORDS.sheet.addressPlaceholder}`;
const CODE_LINE = `a pairing code is ${PAIR_CODE_LENGTH} characters; wsp host pair on that computer prints one`;
const LOGIN_LINE = `the login is ${HOST_WORDS.sheet.loginPlaceholder}, as ssh takes it`;
const NO_SSH_LINE = "this app has no ssh road";

/** An ssh login as ssh takes it and nothing ssh could read as an option: a word opening with a dash would be one. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9.:_-]*)?$/;

/** Only the sheet's own shape comes off the wire; anything else is refused before a road is walked. */
export function parseConnectAsk(raw: unknown): HostConnectAsk | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const ask = raw as Record<string, unknown>;
  if (ask["road"] === "direct" && typeof ask["url"] === "string" && typeof ask["code"] === "string") return { road: "direct", url: ask["url"], code: ask["code"] };
  if (ask["road"] === "ssh" && typeof ask["address"] === "string" && (ask["port"] === undefined || (typeof ask["port"] === "number" && Number.isInteger(ask["port"]) && ask["port"] > 0 && ask["port"] < 65536))) {
    return { road: "ssh", address: ask["address"], ...(typeof ask["port"] === "number" ? { port: ask["port"] } : {}) };
  }
  return undefined;
}

export function hostSwitcher(deps: SwitcherDeps): HostSwitcher {
  let current = deps.local;
  const io: CliIO = { log: deps.log, error: deps.log, ask: refuse, askSecret: refuse };
  const connect = deps.connect ?? connectCommand;
  const disconnect = deps.disconnect ?? disconnectCommand;
  const dial = deps.dial ?? dialHost;
  const opts = { statePath: deps.statePath, home: deps.home };

  const direct: Road<Extract<HostConnectAsk, { road: "direct" }>> = {
    // What wsp host pair prints is one word: the code and the fingerprint of the key that host proves. Both
    // halves are read here, since a word missing either one would be dialled and refused over there with a
    // sentence this sheet could not put under a field.
    check: ask => {
      if (!isUrl(ask.url)) return { ok: false, at: "url", error: ADDRESS_LINE };
      const typed = readJoinToken(ask.code);
      if (typed.code.length !== PAIR_CODE_LENGTH) return { ok: false, at: "code", error: CODE_LINE };
      return typed.hostKey === undefined ? { ok: false, at: "code", error: PAIR_NO_KEY_REFUSAL } : undefined;
    },
    open: async ask => ({ url: ask.url, code: ask.code, alias: aliasFrom(new URL(ask.url).hostname), label: new URL(ask.url).host, road: "direct" }),
    reach: async (_alias, record) => record.url,
    at: e => (isAuth(e) ? "code" : "url"),
    close: () => {},
  };
  const ssh: Road<Extract<HostConnectAsk, { road: "ssh" }>> = {
    check: ask => (!LOGIN.test(ask.address.trim()) ? { ok: false, at: "address", error: LOGIN_LINE } : deps.ssh === undefined ? { ok: false, at: "address", error: NO_SSH_LINE } : undefined),
    open: async ask => {
      const road = sshRoadOf(deps);
      const address = ask.address.trim();
      const login = { address, ...(ask.port !== undefined ? { port: ask.port } : {}) };
      try {
        const opened = await road.open(login);
        return { url: opened.url, code: opened.code, alias: aliasFrom(address), label: address, road: "ssh", ssh: login };
      } catch (e) {
        road.closeForward(forwardKey(login));
        throw e;
      }
    },
    // The box's lock is read on every switch, so a service that came back on another port is found there; the
    // forward keeps the local port the record names when it can, and the record follows when it cannot.
    reach: async (alias, record) => {
      if (record.ssh === undefined) return record.url;
      const url = await sshRoadOf(deps).reach(record.ssh, portOf(record.url));
      if (url !== record.url) writeHost(deps.home, alias, { ...record, url });
      return url;
    },
    at: () => "address",
    close: record => {
      if (record.ssh !== undefined) deps.ssh?.closeForward(forwardKey(record.ssh));
    },
  };
  const ROADS: { readonly [K in HostRoad]: Road<Extract<HostConnectAsk, { road: K }>> } = { direct, ssh };
  /** A record the command line wrote carries no road and is an address. */
  const roadOf = (record: HostRecord): Road => ROADS[record.road ?? "direct"] as Road;

  /** A record off the account, dialled once before the window moves: the first dial admits this computer over
   * there and a token that host no longer takes is renewed on the same road the command line takes, so the page
   * is handed one that opens. What the dial wrote under the alias is what the session carries. A record from a
   * pairing code is moved to as it always was. */
  const admitted = async (alias: string, record: HostRecord): Promise<HostRecord> => {
    if (hostRoadWord(record) !== "account") return record;
    // The name goes through the rule every verb reads which host it runs against by, so a record holding a token
    // and no key for the host is refused here as it is there rather than dialled.
    (await dial(deps.statePath, { aim: aimedHost(deps.statePath, { host: alias, home: deps.home }), home: deps.home })).close();
    return readHost(deps.home, alias) ?? record;
  };

  /** What the menu lists: every host this computer holds, less its own record on the account. The account record
   * whose host id is the one in this computer's relay record is this computer, which the row for here already is,
   * and a row for it would dial this computer through the relay and admit it as a device of itself. */
  const elsewhere = (): HostEntry[] => {
    const away = new Set(accountHosts(deps.statePath, deps.home).map(held => held.alias));
    const account = new Set(accountRecords(deps.home).map(held => held.alias));
    return listHosts(deps.home).filter(entry => away.has(entry.alias) || !account.has(entry.alias));
  };
  const moveTo = async (session: HostSession, hash?: string): Promise<void> => {
    current = session;
    deps.log(`on ${session.label} at ${session.url}`);
    await deps.load(session, hash);
  };

  return {
    current: () => current,
    view: () => ({
      here: deps.here,
      current: current.alias ?? null,
      hosts: elsewhere().map(h => ({ alias: h.alias, label: h.label ?? h.alias, url: h.url, road: h.road ?? "direct" })),
    }),
    token: () => (current.remote ? current.deviceToken : hostTokenFor(deps.statePath)),
    async to(alias, hash) {
      try {
        if (alias === null) {
          await moveTo(deps.local, hash);
          return { ok: true };
        }
        const held = readHost(deps.home, alias);
        if (held === undefined) throw new Error(noSuchHostLine(alias, deps.home));
        const record = await admitted(alias, held);
        await moveTo(remoteSession(alias, record, await roadOf(record).reach(alias, record)), hash);
        return { ok: true };
      } catch (e) {
        return failed("url", e);
      }
    },
    async connect(ask) {
      const road = ROADS[ask.road] as Road;
      const held = road.check(ask);
      if (held !== undefined) return held;
      try {
        const opened = await road.open(ask);
        // The same road wsp host connect takes, so the record is the one wsp hosts lists and wsp host forget takes away.
        await connect(io, opts, { code: opened.code, name: opened.alias }, [opened.url]);
        const record = readHost(deps.home, opened.alias);
        if (record === undefined) throw new Error(`wsp host connect wrote no record for ${opened.alias}`);
        const remembered: HostRecord = { ...record, label: opened.label, road: opened.road, ...(opened.ssh !== undefined ? { ssh: opened.ssh } : {}) };
        writeHost(deps.home, opened.alias, remembered);
        await moveTo(remoteSession(opened.alias, remembered, opened.url));
        return { ok: true };
      } catch (e) {
        return failed(road.at(e), e);
      }
    },
    async disconnect(alias) {
      const record = readHost(deps.home, alias);
      if (record === undefined) return { ok: false, at: "url", error: noSuchHostLine(alias, deps.home) };
      try {
        await disconnect(io, opts, [alias]);
      } catch (e) {
        return failed("url", e);
      }
      roadOf(record).close(record);
      if (current.alias === alias) await moveTo(deps.local);
      return { ok: true };
    },
    closeAll: () => deps.ssh?.closeAll(),
  };
}
