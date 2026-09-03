// SPDX-License-Identifier: AGPL-3.0-only
// The guest half of the sign-in callback relay: the browser shim's script and
// the socket it posts to, the URL parsing that finds a flow's callback port,
// the terminal fallback for the same, and the listener heuristic for flows
// whose URL names no port.
import { EventEmitter } from "node:events";
import { mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";

/** BROWSER value and xdg-open target on the guest. A bare path: tools append
 * the URL as the one argument, and Claude Code treats the literal "true" as
 * its never-open sentinel. */
export const OPEN_SHIM_PATH = "/usr/local/bin/wsp-open";
export const XDG_OPEN_PATH = "/usr/local/bin/xdg-open";
/** Where the shim posts in the guest; root-only through the daemon's umask, unreachable from the edge. */
export const OPEN_SOCKET_PATH = "/root/.wsp/open.sock";

/** POSIX sh with curl only: the base image has neither xdg-utils nor python
 * on PATH for every template. gh, gcloud and aws block until the shim exits,
 * so it posts and returns without waiting for the laptop; it prints nothing,
 * since gh wires its output into the tool's own terminal. */
export const OPEN_SHIM_SCRIPT = `#!/bin/sh
[ "$#" -ge 1 ] || exit 0
printf '%s' "$1" | curl -s -m 1 -o /dev/null --unix-socket ${OPEN_SOCKET_PATH} -X POST --data-binary @- http://wsp/open >/dev/null 2>&1
exit 0
`;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Below this the laptop would need root to bind; the host refuses them, so they are never named. */
const MIN_RELAY_PORT = 1024;

/** Copies of @wsp/protocol's HTTP_URL_RE, HTTP_URL_MAX and isHttpUrl: importing that package would
 * bundle zod into the guest for one rule. The daemon test pins them equal. */
export const OPEN_URL_RE = /^https?:\/\/[^\s\x00-\x1f\x7f]+$/i;
export const OPEN_URL_MAX = 8192;
export function isOpenUrl(url: string): boolean {
  if (url.length > OPEN_URL_MAX || !OPEN_URL_RE.test(url)) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** The localhost port a sign-in URL redirects to, read from its redirect_uri;
 * absent when there is no redirect_uri, it names another host, or it has no
 * explicit port (aws registers http://127.0.0.1/oauth/callback bare). */
export function callbackPortOf(url: string): number | undefined {
  let redirect: string | null;
  try {
    redirect = new URL(url).searchParams.get("redirect_uri");
  } catch {
    return undefined;
  }
  if (redirect === null) return undefined;
  let target: URL;
  try {
    target = new URL(redirect);
  } catch {
    return undefined;
  }
  if (!LOOPBACK_HOSTS.has(target.hostname) || target.port === "") return undefined;
  const port = Number(target.port);
  return Number.isInteger(port) && port >= MIN_RELAY_PORT && port <= 65535 ? port : undefined;
}

// OSC 8 ; params ; URI ST, terminated by BEL or ESC backslash.
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const URL_IN_TEXT = /https?:\/\/[^\s"'`<>\x07\x1b]+/gi;

/** Claude Code wraps its URL in an OSC 8 hyperlink, so the raw stream carries
 * it twice: once in the escape, once as text. Strip the escapes first. */
export function stripOsc8(text: string): string {
  return text.replace(OSC8, "");
}

/** Callback ports named by URLs in a terminal chunk: the forward's fallback
 * for a tool that prints its URL but reaches neither shim. */
export function callbackPortsIn(text: string): number[] {
  const ports = new Set<number>();
  for (const m of stripOsc8(text).matchAll(URL_IN_TEXT)) {
    const port = callbackPortOf(m[0].replace(/[.,;!?)]+$/, ""));
    if (port !== undefined) ports.add(port);
  }
  return [...ports];
}

/** Ports named by URLs that end before the text does: a URL still running at
 * the end may be cut mid-port (":8" of ":8976"), so it waits for the next chunk. */
function settledCallbackPorts(text: string): number[] {
  const clean = stripOsc8(text);
  const ports = new Set<number>();
  for (const m of clean.matchAll(URL_IN_TEXT)) {
    if (m.index + m[0].length === clean.length) continue;
    const port = callbackPortOf(m[0].replace(/[.,;!?)]+$/, ""));
    if (port !== undefined) ports.add(port);
  }
  return [...ports];
}

/** Keeps the tail of a pty's output so a URL split across chunks still matches. */
export class TerminalUrlScanner {
  private tail = "";
  constructor(private readonly tailChars = 2048) {}
  /** Ports newly seen in this chunk (with the kept tail in front of it). */
  feed(chunk: string): number[] {
    const text = this.tail + chunk;
    const before = new Set(settledCallbackPorts(this.tail));
    this.tail = text.slice(-this.tailChars);
    return settledCallbackPorts(text).filter(p => !before.has(p));
  }
}

export interface SpotterOptions {
  now?: () => number;
  /** How long after the open to wait for a loopback listener to appear. */
  afterMs?: number;
}

/** Pairs a browser.open that names no port with the loopback listener the
 * port watcher reports after it, within the window. A listener already there
 * when the open came is not the flow's: a dev server on 3000 must never have
 * the laptop's 3000 bound. Tools bind and open milliseconds apart and the
 * watcher polls every second, so the flow's own listener still lands after. */
export class CallbackSpotter {
  private readonly now: () => number;
  private readonly afterMs: number;
  /** At most one open ask: a second spot() while one waits replaces it instead of doubling the answer. */
  private pending: { until: number; onPort: (port: number) => void } | undefined;

  constructor(o: SpotterOptions = {}) {
    this.now = o.now ?? Date.now;
    this.afterMs = o.afterMs ?? 5_000;
  }

  noteOpen(port: number, loopback: boolean): void {
    if (!loopback || port < MIN_RELAY_PORT) return;
    const ask = this.pending;
    if (ask === undefined) return;
    this.pending = undefined;
    if (ask.until >= this.now()) ask.onPort(port);
  }

  spot(onPort: (port: number) => void): void {
    this.pending = { until: this.now() + this.afterMs, onPort };
  }
}

const OPEN_BODY_CAP = 8 * 1024;

export interface OpenSocket extends EventEmitter {
  on(event: "url", listener: (url: string) => void): this;
  close(): Promise<void>;
}

/** The unix socket the shim posts to: POST /open with the URL as the body. */
export async function listenOpenSocket(path: string): Promise<OpenSocket> {
  const emitter = new EventEmitter() as OpenSocket;
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/open") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= OPEN_BODY_CAP) chunks.push(c);
    });
    req.on("end", () => {
      const url = Buffer.concat(chunks).toString("utf8").trim();
      if (size > OPEN_BODY_CAP || !isOpenUrl(url)) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(204).end();
      emitter.emit("url", url);
    });
  });
  mkdirSync(dirname(path), { recursive: true });
  try {
    unlinkSync(path);
  } catch {
    // no stale socket file
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  emitter.close = () =>
    new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return emitter;
}
