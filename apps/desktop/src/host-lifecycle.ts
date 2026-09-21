// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultHomeIn, devCheckoutState, dialAddress, homeNamed, hostTokenFor, lockPathFor, ownPid, serve, servingHost, type CliIO, type HostLock, type RunningWsp, type UrlOpener } from "@wsp/host";
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

/** Runs before the setup gate: a serving host is the proof of setup. WSP_HOME
 * names the home when it is set, else this computer's own, and the lock beside
 * that home's state file is the one thing read. A window that should open on
 * another home is launched with WSP_HOME naming it, which is the one way any
 * road here says which home it means. */
export async function locateHost(opts: Launch): Promise<Located> {
  const env = homeNamed(opts.env);
  const home = env !== undefined ? resolve(env) : defaultHomeIn(homedir());
  const session = await lockedHost(statePathIn(home, opts));
  return { home, ...(session !== undefined ? { session } : {}) };
}

/** Attaches to the host already serving this state file, which its lock names
 * and this window has proof of, else starts one the way the wsp bin does.
 * Defaults held by anything else give way to free ports. */
export async function openHost(opts: OpenHostOptions): Promise<HostSession> {
  const held = await lockedHost(opts.statePath);
  if (held !== undefined) return held;
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
