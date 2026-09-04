// SPDX-License-Identifier: AGPL-3.0-only
// Plain local URLs a tool prints or asks to open ("Serving HTTP on 0.0.0.0
// port 8123 (http://0.0.0.0:8123/)", "Local: http://localhost:5173/"): the
// port they name is what the host forwards to the laptop's loopback so the
// link works there. Distinct from a sign-in URL's redirect_uri (relay.ts).
import { cleanTerminalText } from "./relay.js";

/** The host refuses ports below this (root on the laptop), so they are never named. */
const MIN_PORT = 1024;

/** Hosts a dial of localhost on the machine reaches: the loopback names, and
 * the wildcard binds servers print when they listen on every interface. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]);

/** http or https (the tunnel is TCP; the browser speaks TLS to the guest), an explicit port only: a bare host names none. */
export function localhostPortOf(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !LOCAL_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.port === "") return undefined;
  return validPort(Number(parsed.port));
}

function validPort(port: number): number | undefined {
  return Number.isInteger(port) && port >= MIN_PORT && port <= 65535 ? port : undefined;
}

// An optional scheme, a local host and a port, not preceded by a character
// that would make it the tail of a longer address (::ffff:127.0.0.1:8123,
// 10.127.0.0.1:80) and not followed by another digit.
const LOCAL_URL_IN_TEXT = /(?<![\w.\-/@:%])(?:(https?):\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d{1,5})(?!\d)/gi;

/** Ports named by local URLs in text. Without a scheme only the numeric forms
 * count, since "localhost:5432" in an error line is a socket address, not a
 * link a person clicks. */
export function localhostPortsIn(text: string, cols?: number): number[] {
  return settledLocalPorts(`${text} `, cols);
}

/** Ports named by local URLs that end before the text does: a URL still
 * running at the end of a pty chunk may be cut mid-port, so it waits. */
export function settledLocalPorts(text: string, cols?: number): number[] {
  const clean = cleanTerminalText(text, cols);
  const ports = new Set<number>();
  for (const m of clean.matchAll(LOCAL_URL_IN_TEXT)) {
    if (m.index + m[0].length === clean.length) continue;
    const [, scheme, host, digits] = m;
    if (scheme === undefined && host!.toLowerCase() === "localhost") continue;
    const port = validPort(Number(digits));
    if (port !== undefined) ports.add(port);
  }
  return [...ports];
}
