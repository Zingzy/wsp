// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serve, servingHost, type CliIO, type RunningWsp, type UrlOpener } from "@wsp/host";
import type { Runtime } from "@wsp/runtime";

export type PortState = "free" | "wsp" | "other";

export interface HostSession {
  url: string;
  port: number;
  /** True when this process started the host and must stop it on quit. */
  owned: boolean;
  close(): Promise<void>;
}

export interface Located {
  /** Where keys and state are read from when no host is serving. */
  home: string;
  /** A host already serving: through the pointer, the lock, or the port. */
  session?: HostSession;
  /** current-home named this home, but nothing serves it any more. */
  stalePointer?: string;
}

/** How this app was launched, as everything that decides where its state file sits reads it. */
export interface Launch {
  /** app.isPackaged. A packaged app inherits whatever folder the person launched it from, so a .env sitting there
   * says nothing about it; only a development run out of the checkout means the checkout's state. */
  packaged: boolean;
  /** WSP_HOME as launched; a Finder launch has none. It names the home outright, over any launch folder. */
  env?: string;
  cwd: string;
}

export interface LocateOptions extends Launch {
  port: number;
  /** What ~/.wsp/current-home says, when it exists. */
  pointer?: string;
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

// The host serves the page with its boot object inlined; nothing else on
// loopback carries this line, so it is the whole attach test. The token is not
// part of it: a host listening beyond this computer inlines none, and it is
// still the host this window should attach to rather than start a second of.
const BOOT_LINE = /<script>window\.__WSP__ = \{"wsPort":\d+,/;

function canListen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

export async function probeHost(port: number): Promise<PortState> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return (await canListen(port)) ? "free" : "other";
  }
  return res.ok && BOOT_LINE.test(await res.text()) ? "wsp" : "other";
}

function attached(port: number): HostSession {
  return { url: `http://127.0.0.1:${port}`, port, owned: false, close: async () => {} };
}

/** The home WSP_HOME names, or nothing: unset and empty are one answer, and every road that reads the variable
 * reads it here. */
const homeNamed = (env: string | undefined): string | undefined => (env !== undefined && env !== "" ? env : undefined);

/** Same rule as the bin: a .env in cwd marks a dev checkout whose .wsp state is shared with wspx. It holds for a
 * development run and nothing else, since a packaged app is launched from a folder it did not choose, and WSP_HOME
 * names the home over it in every case, which is what the locate doc says. */
export function statePathIn(home: string, launch: Launch): string {
  if (!launch.packaged && homeNamed(launch.env) === undefined && existsSync(join(launch.cwd, ".env"))) return join(launch.cwd, ".wsp", "state.json");
  return join(home, "state.json");
}

/** The host whose lock sits next to this state file, once it answers as wsp. */
async function lockedHost(statePath: string): Promise<HostSession | undefined> {
  const held = servingHost(statePath);
  return held !== undefined && (await probeHost(held.port)) === "wsp" ? attached(held.port) : undefined;
}

/** Runs before the setup gate: a serving host is the proof of setup, wherever
 * its home is. WSP_HOME wins when set; otherwise the pointer is tried first,
 * then ~/.wsp's own lock, then the port. A pointer to a dead host is reported,
 * not followed: its home may be gone, and the truth of setup left with the host. */
export async function locateHost(opts: LocateOptions): Promise<Located> {
  const env = homeNamed(opts.env);
  const home = env !== undefined ? resolve(env) : join(homedir(), ".wsp");
  let stalePointer: string | undefined;
  if (env === undefined && opts.pointer !== undefined) {
    const pointed = await lockedHost(statePathIn(opts.pointer, opts));
    if (pointed !== undefined) return { home: opts.pointer, session: pointed };
    stalePointer = opts.pointer;
  }
  const session =
    (await lockedHost(statePathIn(home, opts))) ??
    (opts.port !== 0 && (await probeHost(opts.port)) === "wsp" ? attached(opts.port) : undefined);
  return { home, ...(session !== undefined ? { session } : {}), ...(stalePointer !== undefined ? { stalePointer } : {}) };
}

/** Attaches to the host already serving this state file (its lock names the
 * port, so a hand-started host on other ports is found too), else to a wsp
 * host on the requested port, else starts one the way the wsp bin does.
 * Defaults held by anything else give way to free ports. */
export async function openHost(opts: OpenHostOptions): Promise<HostSession> {
  const held = await lockedHost(opts.statePath);
  if (held !== undefined) return held;
  const state = opts.port === 0 ? "free" : await probeHost(opts.port);
  if (state === "wsp") return attached(opts.port);
  const defaultsFree = state === "free" && (opts.wsPort === 0 || (await canListen(opts.wsPort)));
  const ports = defaultsFree ? { port: opts.port, wsPort: opts.wsPort } : { port: 0, wsPort: 0 };
  const handle = await serve(opts.io, {
    ...ports,
    statePath: opts.statePath,
    webDir: opts.webDir,
    ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
    ...(opts.openUrl !== undefined ? { openUrl: opts.openUrl } : {}),
    ...(opts.running !== undefined ? { running: opts.running } : {}),
  });
  return { url: `http://127.0.0.1:${handle.port}`, port: handle.port, owned: true, close: () => handle.close() };
}
