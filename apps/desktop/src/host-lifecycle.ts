// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serve, servingHost, type CliIO } from "@wsp/host";
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

export interface LocateOptions {
  port: number;
  /** WSP_HOME as launched; a Finder launch has none. */
  env?: string;
  /** What ~/.wsp/current-home says, when it exists. */
  pointer?: string;
  cwd: string;
}

export interface OpenHostOptions {
  port: number;
  wsPort: number;
  statePath: string;
  webDir: string;
  io: CliIO;
  runtime?: Runtime;
}

// The host serves the page with its boot object inlined; nothing else on
// loopback carries this line, so it is the whole attach test.
const BOOT_LINE = /<script>window\.__WSP__ = \{"wsPort":\d+,"token":"[^"]+"/;

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

// Same rule as the bin: a .env in cwd marks a dev checkout whose .wsp state is shared with wspx.
export function statePathIn(home: string, cwd: string): string {
  if (existsSync(join(cwd, ".env"))) return join(cwd, ".wsp", "state.json");
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
  const env = opts.env !== undefined && opts.env !== "" ? opts.env : undefined;
  const home = env !== undefined ? resolve(env) : join(homedir(), ".wsp");
  let stalePointer: string | undefined;
  if (env === undefined && opts.pointer !== undefined) {
    const pointed = await lockedHost(statePathIn(opts.pointer, opts.cwd));
    if (pointed !== undefined) return { home: opts.pointer, session: pointed };
    stalePointer = opts.pointer;
  }
  const session =
    (await lockedHost(statePathIn(home, opts.cwd))) ??
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
  });
  return { url: `http://127.0.0.1:${handle.port}`, port: handle.port, owned: true, close: () => handle.close() };
}
