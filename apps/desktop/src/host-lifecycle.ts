// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:net";
import { serve, type CliIO } from "@wsp/host";
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

/** Attaches to a wsp host already on the port, else starts one the way the
 * wsp bin does. Defaults held by anything else give way to free ports. */
export async function openHost(opts: OpenHostOptions): Promise<HostSession> {
  const state = opts.port === 0 ? "free" : await probeHost(opts.port);
  if (state === "wsp") {
    return { url: `http://127.0.0.1:${opts.port}`, port: opts.port, owned: false, close: async () => {} };
  }
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
