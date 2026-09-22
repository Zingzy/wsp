// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { accountAim, defaultHomeIn, devCheckoutState, dialAddress, dialHost, homeNamed, hostTokenFor, lockPathFor, ownPid, readHost, serve, servingHost, severalAccountHostsLine, wspHome, type CliIO, type HostLock, type HostRecord, type RunningWsp, type UrlOpener } from "@wsp/host";
import { LOOPBACK, authority, bootLineOf, hereWord, isLoopback, type BootPayload } from "@wsp/protocol";
import { safeEqual, tokenDigest, type Runtime } from "@wsp/runtime";

export type PortState = "free" | "wsp" | "other";

export interface HostSession {
  url: string;
  port: number;
  /** True when this process started the host and must stop it on quit. */
  owned: boolean;
  /** True for a host on another computer, whose page pairs and whose device token the shell holds. */
  remote: boolean;
  /** What the window and the menu call this host. */
  label: string;
  /** The hosts file's name for a host somewhere else; the app's own host has none. */
  alias?: string;
  /** The token this computer was paired with, handed to the page over the bridge and never written into it. */
  deviceToken?: string;
  close(): Promise<void>;
}

export interface Located {
  /** Where keys and state are read from when no host is serving. */
  home: string;
  /** A host already serving: through the lock, or the port. */
  session?: HostSession;
}

/** How this app was launched, as everything that decides where its state file sits reads it. */
export interface Launch {
  /** app.isPackaged. A packaged app inherits whatever folder the person launched it from, so a checkout it happens
   * to open in says nothing about it; only a development run out of one means the checkout's state. */
  packaged: boolean;
  /** WSP_HOME as launched; a Finder launch has none. It names the home outright, over any launch folder. */
  env?: string;
  cwd: string;
}

export interface OpenHostOptions {
  port: number;
  wsPort: number;
  statePath: string;
  webDir: string;
  io: CliIO;
  runtime?: Runtime;
  /** How a guest tool's sign-in URL reaches this computer's browser; the platform opener when absent. */
  openUrl?: UrlOpener;
  /** How this process is started again, for the wsp tools the init job writes into an agent's config: the shim. */
  running?: RunningWsp;
  /** How a host on the account is dialled, which is the command line's own dial. */
  dial?: typeof dialHost;
}

function canListen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** The boot object of the page served at this authority, or nothing where nothing there answers as a wsp host. */
async function bootAt(at: string): Promise<BootPayload | undefined> {
  try {
    const res = await fetch(`http://${at}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? bootLineOf(await res.text()) : undefined;
  } catch {
    return undefined;
  }
}

/** What a port on this computer holds. Read by the ssh road to tell when the host behind a forward is up, and a
 * forward is bound on this computer's own loopback; a page carrying the boot line is no reason on its own to
 * attach, which the lock is. */
export async function probeHost(port: number): Promise<PortState> {
  if ((await bootAt(authority(LOOPBACK, port))) !== undefined) return "wsp";
  return (await canListen(port)) ? "free" : "other";
}

/** Which port a url answers on, read by every session built from an address rather than from a port this app
 * bound: a url with no port is the scheme's own. */
export const portOf = (url: string): number => Number(new URL(url).port) || 80;

/** A session on a host on another computer: the address it answers at now, which a road that forwards may have
 * moved, what the window and the menu call it, and the device token the shell holds for it and hands the page
 * over the bridge. Written once, since the window reaches such a host by opening on it and by moving to it. */
export function remoteSession(alias: string, record: HostRecord, url: string): HostSession {
  return { url, port: portOf(url), owned: false, remote: true, alias, label: record.label ?? alias, deviceToken: record.deviceToken, close: async () => {} };
}

function attached(port: number, url: string): HostSession {
  return { url, port, owned: false, remote: false, label: hereWord(process.platform === "darwin"), close: async () => {} };
}

/** Whether a digest is the one of the token the host serving this state file holds, compared the one way this repo
 * compares a secret. The page carries the digest and this window holds the file, so the compare sends nothing and
 * a page a squatter serves learns nothing by being read. False where no host has written the file, so nothing
 * matches nothing. It lives here rather than beside the token file's own reader because the host package's MCP
 * server may reach no runtime. */
export function hostTokenMatches(statePath: string, digest: string): boolean {
  const held = hostTokenFor(statePath);
  return held !== undefined && safeEqual(tokenDigest(held), digest);
}

/** One sentence for every live lock this window will not attach to, whichever of the three reasons it is: the
 * owner's token is never sent to that page to settle the question, since a squatter would then have it, and the
 * page's digest of it is what is read instead. */
const wontAttach = (statePath: string, lock: HostLock, why: string): Error =>
  new Error(`a host (pid ${lock.pid}) holds ${lockPathFor(statePath)} on port ${lock.port} but ${why}: stop that process or run wsp down, then open wsp again`);

/** The bin's rule, read from the bin: a checkout of wsp in cwd marks a dev run whose .wsp state is shared with wspx. It
 * holds for a development run and nothing else, since a packaged app is launched from a folder it did not choose,
 * and WSP_HOME names the home over it in every case, which is what the locate doc says. */
export function statePathIn(home: string, launch: Launch): string {
  const dev = launch.packaged || homeNamed(launch.env) !== undefined ? undefined : devCheckoutState(launch.cwd);
  return dev ?? join(home, "state.json");
}

/** The host whose lock sits beside this state file, once this window has proof it is the owner's own. The lock is
 * the whole road in: a page on a port carrying the boot line is anything any login on this computer cares to
 * serve. Its pid is this login's, and then one of two readings by the address it bound. A host on loopback serves
 * its page with the digest of its own token inlined, so the page is held to the digest of the token file beside
 * the state. A host bound beyond this computer serves a page with no digest by design, and the lock alone is the
 * reading for it. Either road is dialled where the lock says that host answers, which for a host on ::1 or on
 * 127.0.0.2 is there and nowhere else. Anything else is a refusal: this window starts no second host on a state
 * file another process holds. */
async function lockedHost(statePath: string): Promise<HostSession | undefined> {
  const held = servingHost(statePath);
  if (held === undefined) return undefined;
  if (!ownPid(held.pid)) throw wontAttach(statePath, held, "that process is not this login's");
  const at = authority(dialAddress(held), held.port);
  if (!isLoopback(held.address ?? LOOPBACK)) return attached(held.port, `http://${at}`);
  const boot = await bootAt(at);
  if (boot === undefined) throw wontAttach(statePath, held, "no wsp host answers there");
  if (boot.tokenHash === undefined || !hostTokenMatches(statePath, boot.tokenHash)) throw wontAttach(statePath, held, "the page it serves carries another token's digest than the file beside this state");
  return attached(held.port, `http://${at}`);
}

/** The wsp home a launch means: WSP_HOME when it is set, else this computer's own. A window that should open on
 * another home is launched with WSP_HOME naming it, which is the one way any road here says which home it means. */
export function homeOf(launch: Launch): string {
  const env = homeNamed(launch.env);
  return env !== undefined ? resolve(env) : defaultHomeIn(homedir());
}

/** Where this app keeps Chromium's own files, its profile, caches and worker registrations: one folder beside the
 * state file the launch serves, so two apps on two homes never share one profile. A shared profile's databases
 * are locked by the first app to open them, and the second launch's page load never came back. */
export function userDataIn(launch: Launch): string {
  return join(dirname(statePathIn(homeOf(launch), launch)), "desktop");
}

/** Runs before the setup gate: a serving host is the proof of setup. The lock beside the launch's home's state file
 * is the one thing read. */
export async function locateHost(opts: Launch): Promise<Located> {
  const home = homeOf(opts);
  const session = await lockedHost(statePathIn(home, opts));
  return { home, ...(session !== undefined ? { session } : {}) };
}

/** The host on the account this window opens on when nothing serves here: the one record the rule every verb
 * comes by names, dialled once so this computer is admitted over there and the page is handed a token that
 * opens. Nothing where the account names no host this computer can reach, where several stand and none is
 * marked, or where the one it named refused or did not answer; the window starts a host here as it always did,
 * and the sentence is logged, since the screen that would ask which host is the first run's. */
async function accountSession(opts: OpenHostOptions): Promise<HostSession | undefined> {
  const home = wspHome();
  const aim = accountAim(opts.statePath, home);
  if (aim.kind === "several") {
    opts.io.error(severalAccountHostsLine(aim.aliases));
    return undefined;
  }
  if (aim.kind === "none") return undefined;
  try {
    (await (opts.dial ?? dialHost)(opts.statePath, { aim: { kind: "alias", alias: aim.alias, record: aim.record }, home })).close();
  } catch (e) {
    opts.io.error(`${e instanceof Error ? e.message : String(e)}; this window is opening on the host here instead`);
    return undefined;
  }
  // What the dial left under that alias: the device token the host answered this computer's key with, which the
  // record held none of until now.
  const record = readHost(home, aim.alias) ?? aim.record;
  // Nothing is served on this computer, so the runtime the setup gate built goes away rather than lingering
  // behind the window, which is the rule that gate applies when it has nothing to show.
  await opts.runtime?.close();
  return remoteSession(aim.alias, record, record.url);
}

/** Attaches to the host already serving this state file, which its lock names
 * and this window has proof of, else opens on the host the account names, else
 * starts one the way the wsp bin does. Defaults held by anything else give way
 * to free ports. */
export async function openHost(opts: OpenHostOptions): Promise<HostSession> {
  const held = await lockedHost(opts.statePath);
  if (held !== undefined) return held;
  const away = await accountSession(opts);
  if (away !== undefined) return away;
  const defaultsFree = (opts.port === 0 || (await canListen(opts.port))) && (opts.wsPort === 0 || (await canListen(opts.wsPort)));
  const ports = defaultsFree ? { port: opts.port, wsPort: opts.wsPort } : { port: 0, wsPort: 0 };
  const handle = await serve(opts.io, {
    ...ports,
    statePath: opts.statePath,
    webDir: opts.webDir,
    ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
    ...(opts.openUrl !== undefined ? { openUrl: opts.openUrl } : {}),
    ...(opts.running !== undefined ? { running: opts.running } : {}),
  });
  return { url: `http://${authority(LOOPBACK, handle.port)}`, port: handle.port, owned: true, remote: false, label: hereWord(process.platform === "darwin"), close: () => handle.close() };
}
