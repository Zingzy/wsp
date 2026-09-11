// SPDX-License-Identifier: AGPL-3.0-only
// The box's side of the relay, and the person's client side of it. A box is
// linked by a device code flow the person approves in a browser, keeps the
// token it is given beside its state file, and at every start asks the relay
// for a tunnel and runs the connector against its own loopback port. The
// relay learns where the box answers and nothing else: no pairing code and no
// device token is ever sent here, and a client still pairs with the host
// itself.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname as thisComputer } from "node:os";
import { dirname, join } from "node:path";
import { fmtDuration, usageRefusal } from "@wsp/protocol";
import type { CliIO } from "./cli.js";
import { CLOUDFLARED, connectorRunning, ensureCloudflared, startConnector, stopRecordedConnector, type Connector } from "./connector.js";
import { publicAddressLine } from "./host-lock.js";
import { table } from "./verbs.js";

/** What a linked box keeps: which relay it is on, which host it is there, and the token that names it. The token
 * opens the relay's own routes for this host and nothing else. */
export interface RelayRecord {
  relayUrl: string;
  hostId: string;
  token: string;
  name: string;
  /** Where this box answers from anywhere, once it has a tunnel; a quick tunnel's name changes at every start. */
  hostname?: string;
  linkedAt: string;
}

/** What a person's own computer keeps: the relay it signed in to and the token that lists the hosts on their account. */
export interface RelayClientRecord {
  relayUrl: string;
  token: string;
  name: string;
  linkedAt: string;
}

/** A code stands a quarter of an hour on the relay, so nothing here waits longer than that for the approval. */
const LINK_WAIT_MS = 15 * 60_000;
const POLL_MS = 3_000;
/** A host says it is there every minute; the relay's listing is only as fresh as the last one. */
const HEARTBEAT_MS = 60_000;

export interface RelayDeps {
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** What this computer calls itself on the approval page. */
  deviceName(): string;
  cloudflared(dir: string): Promise<string>;
  connector: typeof startConnector;
  heartbeatMs: number;
}

export const systemRelayDeps: RelayDeps = {
  fetch: (input, init) => fetch(input as string, init),
  now: Date.now,
  sleep: ms => new Promise(done => setTimeout(done, ms)),
  deviceName: thisComputer,
  cloudflared: dir => ensureCloudflared(join(dir, "bin")),
  connector: startConnector,
  heartbeatMs: HEARTBEAT_MS,
};

export function relayRecordPath(statePath: string): string {
  return join(dirname(statePath), "relay.json");
}

const isRecord = (v: unknown): v is RelayRecord =>
  typeof v === "object" && v !== null && typeof (v as RelayRecord).relayUrl === "string" && typeof (v as RelayRecord).hostId === "string" && typeof (v as RelayRecord).token === "string";

function readJsonFile<T>(path: string, holds: (v: unknown) => v is T): T | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return holds(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The token in these files opens the relay, so they are written for this user alone rather than at the umask's word. */
function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // A file that was already there keeps the mode it had, so the mode is set rather than assumed.
  chmodSync(path, 0o600);
}

export function readRelayRecord(statePath: string): RelayRecord | undefined {
  return readJsonFile(relayRecordPath(statePath), isRecord);
}

export function writeRelayRecord(statePath: string, record: RelayRecord): void {
  writeJsonFile(relayRecordPath(statePath), record);
}

export function removeRelayRecord(statePath: string): void {
  rmSync(relayRecordPath(statePath), { force: true });
}

/** The person's own token, not the box's: the two live on one computer whenever a person drives their own host,
 * and the state folder is the wsp home by default, so they cannot share a name. */
export function clientRecordPath(home: string): string {
  return join(home, "relay-client.json");
}

const isClientRecord = (v: unknown): v is RelayClientRecord =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as RelayClientRecord).relayUrl === "string" &&
  typeof (v as RelayClientRecord).token === "string" &&
  (v as RelayRecord).hostId === undefined;

export function readRelayClient(home: string): RelayClientRecord | undefined {
  return readJsonFile(clientRecordPath(home), isClientRecord);
}

/** One call to a relay, with its own sentence when it refuses: the relay's words are the person's words. */
async function relayCall<T>(deps: RelayDeps, url: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (e) {
    throw new Error(`the relay at ${new URL(url).origin} did not answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  const answer = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  if (!res.ok) throw new Error(typeof answer?.error === "string" ? answer.error : `the relay at ${new URL(url).origin} answered ${res.status}`);
  return answer as T;
}

const trimUrl = (url: string): string => url.replace(/\/+$/, "");

interface LinkStarted {
  code: string;
  verifyUrl: string;
  pollToken: string;
  pollAfterMs?: number;
}

interface LinkApproved {
  state: string;
  token: string;
  name: string;
  hostId?: string;
}

/** The device code flow, for a box and for a person's own computer alike: a code shown here, a page they open, and
 * a token collected once it is approved. */
async function linkThrough(io: CliIO, deps: RelayDeps, relayUrl: string, kind: "host" | "client", name: string): Promise<LinkApproved> {
  const started = await relayCall<LinkStarted>(deps, `${relayUrl}/link/start`, { method: "POST", body: { kind, name } });
  io.log(`code        ${started.code}`);
  io.log(`open        ${started.verifyUrl}`);
  io.log(`Open that page, sign in and approve ${name}. The code stands for ${fmtDuration(LINK_WAIT_MS)} and is spent by the approval.`);
  const deadline = deps.now() + LINK_WAIT_MS;
  // The relay says how long to sleep between polls, held between half a second and half a minute: a relay that
  // says zero would have this line spinning for a quarter of an hour.
  const between = Math.min(Math.max(started.pollAfterMs ?? POLL_MS, 500), 30_000);
  while (deps.now() < deadline) {
    await deps.sleep(between);
    const answer = await relayCall<LinkApproved & { state: string }>(deps, `${relayUrl}/link/poll`, { method: "POST", body: { pollToken: started.pollToken } });
    if (answer.state === "approved") return answer;
    if (answer.state === "expired") throw new Error(`the code ${started.code} ran out before it was approved; run the line again for a fresh one`);
  }
  throw new Error(`nobody approved ${started.code} while this line waited; run it again for a fresh code`);
}

/** The client token this computer lists a person's hosts with, signing in through the relay's page when it holds none. */
async function relayClient(io: CliIO, home: string, deps: RelayDeps, url?: string): Promise<RelayClientRecord> {
  const held = readRelayClient(home);
  if (held !== undefined && (url === undefined || trimUrl(url) === held.relayUrl)) return held;
  if (held !== undefined) {
    throw usageRefusal(`this computer is signed in to the relay at ${held.relayUrl}; one at a time, so sign out of that one before ${trimUrl(url ?? "")}`);
  }
  const relayUrl = trimUrl(url ?? "");
  if (relayUrl === "") throw usageRefusal("this computer has signed in to no relay; give the relay's address: wsp relay hosts <url>");
  const name = deps.deviceName();
  const approved = await linkThrough(io, deps, relayUrl, "client", name);
  const record: RelayClientRecord = { relayUrl, token: approved.token, name, linkedAt: new Date(deps.now()).toISOString() };
  writeJsonFile(clientRecordPath(home), record);
  return record;
}

interface RelayHostView {
  id: string;
  name: string;
  hostname: string | null;
  connectorVersion?: string | null;
  lastSeen?: string | null;
}

async function relayHosts(record: RelayClientRecord, deps: RelayDeps): Promise<RelayHostView[]> {
  const { hosts } = await relayCall<{ hosts: RelayHostView[] }>(deps, `${record.relayUrl}/hosts`, { token: record.token });
  return hosts;
}

/** Where a host on the relay answers, for the connect that pairs with it. The relay carries no pairing code: the
 * code still comes from wsp pair on the box itself. */
export async function relayHostUrl(home: string, name: string, deps: RelayDeps = systemRelayDeps): Promise<string> {
  const record = readRelayClient(home);
  if (record === undefined) throw usageRefusal("this computer has signed in to no relay; run wsp relay hosts <url> first, which signs in and lists the boxes on your account");
  const hosts = await relayHosts(record, deps);
  const named = hosts.filter(h => h.name === name);
  // Two boxes under one name is not a guess to make: the ids are what tells them apart, so the line names them.
  if (named.length > 1) throw usageRefusal(`the relay holds ${named.length} hosts called ${name}; name the one you mean by its id: ${named.map(h => h.id).join(", ")}`);
  const found = named[0] ?? hosts.find(h => h.id === name);
  if (found === undefined) {
    const known = hosts.map(h => h.name).join(", ");
    throw usageRefusal(`the relay holds no host called ${name}; it holds ${known === "" ? "none at all" : known}`);
  }
  if (found.hostname === null || found.hostname === "") {
    throw usageRefusal(`the relay has no address for ${name} yet; start it there with wsp up, which asks the relay for a tunnel and says where it landed`);
  }
  return `https://${found.hostname}`;
}

/** The rows wsp relay hosts prints; never the token, which a listing has no use for. */
export function relayHostLines(hosts: readonly RelayHostView[]): string[] {
  if (hosts.length === 0) return ["Your relay account holds no box yet. Run wsp relay link <url> on the computer you want to reach."];
  return table([
    ["HOST", "ADDRESS", "CONNECTOR", "LAST SEEN"],
    ...hosts.map(h => [h.name, h.hostname === null || h.hostname === "" ? "not up yet" : `https://${h.hostname}`, h.connectorVersion ?? "", h.lastSeen ?? ""]),
  ]);
}

const RELAY_USAGE = [
  "usage: wsp relay link <url> [--name <name>]",
  "       wsp relay unlink",
  "       wsp relay hosts [<url>]",
  "       wsp relay clients",
  "       wsp relay clients revoke <id>",
].join("\n");

interface RelayClientView {
  id: string;
  name: string;
  signedInAt?: string;
  lastSeen?: string | null;
  thisOne?: boolean;
}

/** The rows wsp relay clients prints: which computers hold a token for this account, and which one is this. */
export function relayClientLines(clients: readonly RelayClientView[]): string[] {
  if (clients.length === 0) return ["No computer is signed in to that relay. Run wsp relay hosts <url> to sign this one in."];
  return table([
    ["COMPUTER", "ID", "SIGNED IN", "LAST SEEN", ""],
    ...clients.map(c => [c.name, c.id, c.signedInAt ?? "", c.lastSeen ?? "", c.thisOne === true ? "this one" : ""]),
  ]);
}

export interface RelayCommandOpts {
  statePath: string;
  home: string;
}

export async function relayCommand(io: CliIO, opts: RelayCommandOpts, args: readonly string[], values: { name?: string }, deps: RelayDeps = systemRelayDeps): Promise<number> {
  const [word, second, third, ...rest] = args;
  if (word === undefined || rest.length > 0) throw usageRefusal(RELAY_USAGE);
  const noMore = (): void => {
    if (third !== undefined) throw usageRefusal(RELAY_USAGE);
  };
  if (word === "link") {
    noMore();
    return relayLink(io, opts, second, values, deps);
  }
  if (word === "unlink") {
    if (second !== undefined) throw usageRefusal(`wsp relay unlink takes the relay this computer is already on, so it needs no address\n\n${RELAY_USAGE}`);
    return relayUnlink(io, opts, deps);
  }
  if (word === "hosts") {
    noMore();
    return relayHostsCommand(io, opts, second, deps);
  }
  if (word === "clients") {
    if (second !== undefined && (second !== "revoke" || third === undefined)) throw usageRefusal(RELAY_USAGE);
    return relayClientsCommand(io, opts, second === "revoke" ? third : undefined, deps);
  }
  throw usageRefusal(`unknown command: wsp relay ${word}\n\n${RELAY_USAGE}`);
}

/** The computers signed in to this person's relay, and the one line that takes one away. A token that walked off
 * with a laptop is stopped here, without touching the boxes. */
async function relayClientsCommand(io: CliIO, opts: RelayCommandOpts, revoke: string | undefined, deps: RelayDeps): Promise<number> {
  const record = await relayClient(io, opts.home, deps);
  if (revoke !== undefined) {
    await relayCall(deps, `${record.relayUrl}/clients/${encodeURIComponent(revoke)}`, { method: "DELETE", token: record.token });
    io.log(`${revoke} is signed out of ${record.relayUrl}; the token it held opens nothing`);
    return 0;
  }
  const { clients } = await relayCall<{ clients: RelayClientView[] }>(deps, `${record.relayUrl}/clients`, { token: record.token });
  for (const line of relayClientLines(clients)) io.log(line);
  return 0;
}

async function relayLink(io: CliIO, opts: RelayCommandOpts, address: string | undefined, values: { name?: string }, deps: RelayDeps): Promise<number> {
  const held = readRelayRecord(opts.statePath);
  if (held !== undefined) throw usageRefusal(`this computer is already linked to the relay at ${held.relayUrl} as ${held.name}; wsp relay unlink takes it off first`);
  if (address === undefined || !/^https?:\/\//i.test(address)) throw usageRefusal(`wsp relay link takes the address of the relay, starting http:// or https://\n\n${RELAY_USAGE}`);
  const relayUrl = trimUrl(address);
  const name = values.name ?? deps.deviceName();
  const approved = await linkThrough(io, deps, relayUrl, "host", name);
  if (approved.hostId === undefined) throw new Error(`the relay at ${relayUrl} approved this computer without naming a host; it runs another version of the relay`);
  const record: RelayRecord = { relayUrl, hostId: approved.hostId, token: approved.token, name, linkedAt: new Date(deps.now()).toISOString() };
  writeRelayRecord(opts.statePath, record);
  io.log(`relay       ${relayUrl}`);
  io.log(`host        ${name}`);
  io.log("This computer asks that relay for a tunnel every time wsp up runs, and says where it answers. wsp relay unlink takes it back off.");
  return 0;
}

async function relayUnlink(io: CliIO, opts: RelayCommandOpts, deps: RelayDeps): Promise<number> {
  const record = readRelayRecord(opts.statePath);
  if (record === undefined) throw usageRefusal("this computer is on no relay; wsp relay link <url> puts it on one");
  // The record goes first of all, so the host that is serving starts no connector in place of the one stopped next,
  // and the connector goes before the relay is told: a tunnel with connections still registered cannot be deleted.
  removeRelayRecord(opts.statePath);
  await stopRecordedConnector(dirname(opts.statePath));
  // The record is gone whatever the relay says: a relay that is down must not leave this computer holding a token
  // it cannot use, and the line below says what is left to do over there.
  try {
    await relayCall(deps, `${record.relayUrl}/hosts/${record.hostId}`, { method: "DELETE", token: record.token });
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e));
    io.error(`the relay may still hold this computer as ${record.name}; take it off there with wsp relay hosts on your own computer.`);
  }
  io.log(`unlinked from ${record.relayUrl}; the tunnel is stopped and this computer holds no token for it`);
  return 0;
}

async function relayHostsCommand(io: CliIO, opts: RelayCommandOpts, address: string | undefined, deps: RelayDeps): Promise<number> {
  const record = await relayClient(io, opts.home, deps, address);
  for (const line of relayHostLines(await relayHosts(record, deps))) io.log(line);
  return 0;
}

export interface RelayUp {
  /** Where this host answers from anywhere, once the tunnel has a name; nothing when the connector never got one. */
  hostname(): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface RelayStartOpts {
  statePath: string;
  /** The loopback port the tunnel carries to: the app's own port, so the host may stay on loopback. */
  port: number;
  log(line: string): void;
}

/** What a linked host does at every start: ask for a tunnel, run the connector, and keep saying it is there.
 * Nothing here can take the host down: a relay that is off or a connector that will not run is one line and a
 * host that goes on serving the computer it is on. */
export async function startRelay(opts: RelayStartOpts, deps: RelayDeps = systemRelayDeps): Promise<RelayUp | undefined> {
  const record = readRelayRecord(opts.statePath);
  if (record === undefined) return undefined;
  const stateDir = dirname(opts.statePath);
  // A connector an earlier run left behind would hold the same tunnel open; its pid is the one that run wrote down.
  await stopRecordedConnector(stateDir);
  let asked: { tunnelToken: string | null; hostname: string | null; why?: string };
  let bin: string;
  try {
    asked = await relayCall(deps, `${record.relayUrl}/hosts/${record.hostId}/tunnel`, { method: "POST", token: record.token, body: { port: opts.port } });
    bin = await deps.cloudflared(stateDir);
  } catch (e) {
    opts.log(`relay: no tunnel this time (${e instanceof Error ? e.message : String(e)}); this host is still served on the addresses above`);
    return undefined;
  }
  if (asked.hostname === null && asked.why !== undefined) opts.log(`relay: ${asked.why}`);

  let connector: Connector;
  try {
    connector = deps.connector({
      bin,
      stateDir,
      port: opts.port,
      ...(asked.tunnelToken !== null ? { token: asked.tunnelToken } : {}),
      log: opts.log,
      // wsp relay unlink stops the child and takes the record away; this host is what would otherwise start another.
      keepRunning: () => readRelayRecord(opts.statePath) !== undefined,
    });
  } catch (e) {
    opts.log(`relay: the connector would not start (${e instanceof Error ? e.message : String(e)}); this host is still served on the addresses above`);
    return undefined;
  }

  // A heartbeat carries a hostname only for a quick tunnel, which is the one name the box learns and the relay does
  // not: a managed name is the relay's own, and a box that reported one back would be refused and never read as up.
  const ownName = asked.hostname === null;
  const say = async (hostname: string | undefined): Promise<void> => {
    const name = ownName ? (hostname ?? readRelayRecord(opts.statePath)?.hostname) : undefined;
    await relayCall(deps, `${record.relayUrl}/hosts/${record.hostId}/heartbeat`, {
      method: "POST",
      token: record.token,
      body: { ...(name !== undefined && name !== "" ? { hostname: name } : {}), version: CLOUDFLARED.version },
    });
  };

  const reported = (async (): Promise<string | undefined> => {
    const hostname = asked.hostname ?? (await connector.hostname());
    if (hostname === undefined) return undefined;
    opts.log(publicAddressLine(hostname));
    writeRelayRecord(opts.statePath, { ...record, hostname });
    try {
      await say(hostname);
    } catch (e) {
      opts.log(`relay: could not say where this host is (${e instanceof Error ? e.message : String(e)})`);
    }
    return hostname;
  })();

  const beat = setInterval(() => {
    void say(undefined).catch((e: unknown) => opts.log(`relay: could not say where this host is (${e instanceof Error ? e.message : String(e)})`));
  }, deps.heartbeatMs);
  // A heartbeat must not hold this process up when everything else is done.
  beat.unref?.();

  return {
    hostname: () => reported,
    close: async () => {
      clearInterval(beat);
      await connector.stop();
    },
  };
}

/** What a box behind a relay says at start: it binds this computer alone and is still reachable from anywhere, so
 * the page it serves carries no token and a client pairs for one, exactly as a host that bound an address does. */
export function relayOnLoopbackLine(): string {
  return "this host is on a relay, so it can be reached from anywhere it can dial out: the page carries no token and pairing is the gate. Run wsp pair for a code, and wsp devices to see who took one.";
}

/** Where this host answers from anywhere: the name the record holds, and only while a connector this computer
 * started is carrying it. A name with nothing behind it is worse than no name, since every line that prints one
 * is telling somebody where to reach this host. */
export function publicHostname(statePath: string): string | undefined {
  const record = readRelayRecord(statePath);
  if (record?.hostname === undefined || !connectorRunning(dirname(statePath))) return undefined;
  return record.hostname;
}

