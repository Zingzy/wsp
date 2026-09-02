// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:net";
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

/** Attaches to the host already serving this state file (its lock names the
 * port, so a hand-started host on other ports is found too), else to a wsp
 * host on the requested port, else starts one the way the wsp bin does.
 * Defaults held by anything else give way to free ports. */
export async function openHost(opts: OpenHostOptions): Promise<HostSession> {
  const held = servingHost(opts.statePath);
  if (held !== undefined && (await probeHost(held.port)) === "wsp") return attached(held.port);
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
