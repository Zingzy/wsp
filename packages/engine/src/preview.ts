// SPDX-License-Identifier: AGPL-3.0-only
import type { Machine, PreviewReach } from "./machine.js";

/** Measured Solari TTL: the pt_token exp claim is 60 minutes from mint. */
export const PREVIEW_TTL_MS = 60 * 60_000;

/** Reuse a minted reach while more than this remains; below it, remint.
 * 10 min of a 60-min TTL keeps URLs younger than ~50 min in circulation. */
export const PREVIEW_REFRESH_MARGIN_MS = 10 * 60_000;

/** The in-guest daemon's port (mirrors @wsp/daemon DEFAULT_PORT; the engine
 * cannot import the daemon package, which only runs inside guests). */
export const DAEMON_PORT = 7070;

/** Epoch-ms expiry of a preview token. Not a 3-part JWT: base64url(JSON
 * claims) + "." + signature, and the sandboxId claim embeds literal dots, so
 * cut at the last dot first and fall back to decoding the whole string. */
export function previewTokenExpiry(token: string, now = Date.now()): number {
  for (const cut of [token.lastIndexOf("."), token.length]) {
    if (cut <= 0) continue;
    const decoded = Buffer.from(token.slice(0, cut), "base64url").toString("utf8");
    const exp = /"exp":(\d+)/.exec(decoded)?.[1];
    if (exp !== undefined) return Number(exp);
  }
  return now + PREVIEW_TTL_MS;
}

export function previewIsFresh(reach: PreviewReach, now = Date.now()): boolean {
  return reach.expiresAt - now > PREVIEW_REFRESH_MARGIN_MS;
}

/** Hand back `current` while it is fresh, otherwise mint a replacement.
 * Reminting returns the same hostname with a rotated token, so holders only
 * ever swap tokens, never URLs. */
export async function refreshPreviewToken(
  machine: Machine,
  port: number,
  current?: PreviewReach,
  now = Date.now(),
): Promise<PreviewReach> {
  if (current && previewIsFresh(current, now)) return current;
  if (!machine.previewUrl) {
    throw new Error(`machine ${machine.id} is on a backend without preview URLs`);
  }
  return machine.previewUrl(port);
}
