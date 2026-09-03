// SPDX-License-Identifier: AGPL-3.0-only
// Address-bar arithmetic for routes the runtime mints: the pt_token query
// parameter is the route's bearer, so the bar never shows it while copy and
// the frame keep it.

const TOKEN_PARAM = "pt_token";

export function elideToken(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.searchParams.has(TOKEN_PARAM)) return url;
  parsed.searchParams.delete(TOKEN_PARAM);
  return parsed.toString();
}

export const loopbackUrl = (port: number): string => `http://localhost:${port}`;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * The guest port a typed address means: "3000", ":3000", "localhost:3000" or
 * a loopback URL. Anything on another host is not something this pane can
 * frame, so it parses to null.
 */
export function parsePortInput(raw: string): number | null {
  const text = raw.trim();
  if (/^:?\d{1,5}$/.test(text)) return validPort(Number(text.replace(/^:/, "")));
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (parsed.port === "") return parsed.protocol === "https:" ? 443 : 80;
  return validPort(Number(parsed.port));
}

function validPort(n: number): number | null {
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}
