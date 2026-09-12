// SPDX-License-Identifier: AGPL-3.0-only
// The guest half of the sign-in callback relay: the browser shim's script and
// the socket it posts to, the terminal fallback that finds a flow's callback
// port in what a pty printed, and the listener heuristic for flows whose URL
// names no port. The rule for reading that port out of a URL is the
// protocol's, which the host reads too.
import { EventEmitter } from "node:events";
import { mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { OPEN_SOCKET_PATH, RelayPort, callbackPortOf } from "@wsp/protocol";

/** POSIX sh with curl only: the base image has neither xdg-utils nor python
 * on PATH for every template. gh, gcloud and aws block until the shim exits,
 * so it posts and returns without waiting for the laptop; it prints nothing,
 * since gh wires its output into the tool's own terminal. */
export const OPEN_SHIM_SCRIPT = `#!/bin/sh
[ "$#" -ge 1 ] || exit 0
printf '%s' "$1" | curl -s -m 1 -o /dev/null --unix-socket ${OPEN_SOCKET_PATH} -X POST --data-binary @- http://wsp/open >/dev/null 2>&1
exit 0
`;

/** Copies of @wsp/protocol's HTTP_URL_RE, HTTP_URL_MAX and isHttpUrl; the daemon test pins them equal. */
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

// OSC 8 ; params ; URI ST, terminated by BEL or ESC backslash; the URI is what the link points at.
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// Any other OSC (a window title, a prompt mark): invisible, so it must not count toward the width.
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// CSI: ESC [ parameter bytes (0x30..0x3F, so ? < = > too), intermediates, one final byte. Colour and bold land
// inside URLs (vite bolds the port); a TUI leaves private-parameter sequences on the line it exits to.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// DCS and APC strings (ESC P ... ST, ESC _ ... ST): invisible, so they must not count toward the width either.
const DCS_APC = /\x1b[P_][^\x1b\x07]*(?:\x1b\\|\x07)/g;
// A space and a bare carriage return, no line feed: readline's soft wrap when the typed line reaches the pty
// width, and also how a progress bar redraws. Only the width tells them apart.
const SPACE_CR = / \r(?!\n)/g;
const URL_IN_TEXT = /https?:\/\/[^\s"'`<>\x07\x1b]+/gi;

/** Claude Code wraps its URL in an OSC 8 hyperlink, so the raw stream carries
 * it twice: once in the escape, once as text. Strip the escapes first. */
export function stripOsc8(text: string): string {
  return text.replace(OSC8, "");
}

/** Terminal text as a URL matcher must see it: each hyperlink escape replaced
 * by the URI it carried (the visible text may be a word), colour and bold gone,
 * and a typed line readline wrapped at the pty width joined back into one. With
 * no width known, a space and carriage return stay what they are: a redraw. */
export function cleanTerminalText(text: string, cols?: number): string {
  const flat = text
    .replace(OSC8, (_m, uri: string) => (uri === "" ? "" : `${uri} `))
    .replace(OSC, "")
    .replace(DCS_APC, "")
    .replace(CSI, "");
  if (cols === undefined) return flat;
  return flat.replace(SPACE_CR, (m, at: number) => {
    // readline emits the space and carriage return once the typed line has filled the width: cols visible
    // characters since the last line break (measured on bash 3.2 and bash 5 in a 40 column pty).
    const lineStart = Math.max(flat.lastIndexOf("\n", at - 1), flat.lastIndexOf("\r", at - 1)) + 1;
    return at - lineStart === cols ? "" : m;
  });
}

/** Callback ports named by URLs in a terminal chunk: the forward's fallback
 * for a tool that prints its URL but reaches neither shim. */
export function callbackPortsIn(text: string, cols?: number): number[] {
  const ports = new Set<number>();
  for (const m of cleanTerminalText(text, cols).matchAll(URL_IN_TEXT)) {
    const port = callbackPortOf(m[0].replace(/[.,;!?)]+$/, ""));
    if (port !== undefined) ports.add(port);
  }
  return [...ports];
}

/** Ports named by URLs that end before the text does: a URL still running at
 * the end may be cut mid-port (":8" of ":8976"), so it waits for the next chunk. */
function settledCallbackPorts(text: string, cols?: number): number[] {
  const clean = cleanTerminalText(text, cols);
  const ports = new Set<number>();
  for (const m of clean.matchAll(URL_IN_TEXT)) {
    if (m.index + m[0].length === clean.length) continue;
    const port = callbackPortOf(m[0].replace(/[.,;!?)]+$/, ""));
    if (port !== undefined) ports.add(port);
  }
  return [...ports];
}

/** Keeps the tail of a pty's output so a URL split across chunks still matches;
 * the extractor decides which ports a text names (callback ports by default),
 * and reads the pty's width at scan time so a wrapped typed line is joined. */
export class TerminalUrlScanner {
  private tail = "";
  constructor(
    private readonly extract: (text: string, cols?: number) => number[] = settledCallbackPorts,
    private readonly cols?: () => number,
    private readonly tailChars = 2048,
  ) {}
  /** Ports newly seen in this chunk (with the kept tail in front of it). */
  feed(chunk: string): number[] {
    const text = this.tail + chunk;
    const width = this.cols?.();
    const before = new Set(this.extract(this.tail, width));
    this.tail = text.slice(-this.tailChars);
    return this.extract(text, width).filter(p => !before.has(p));
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
    // A port the laptop could not bind is never named; the protocol's own rule for that is RelayPort.
    if (!loopback || !RelayPort.safeParse(port).success) return;
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
