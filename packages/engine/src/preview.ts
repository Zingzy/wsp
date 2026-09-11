// SPDX-License-Identifier: AGPL-3.0-only
import type { Machine, PreviewReach } from "./machine.js";

/** Reuse a minted reach while more than this remains before its expiry; below it, remint. On a provider whose
 * tokens live an hour this keeps URLs younger than about fifty minutes in circulation. */
export const PREVIEW_REFRESH_MARGIN_MS = 10 * 60_000;

/** The in-guest daemon's port (mirrors @wsp/daemon DEFAULT_PORT; the engine
 * cannot import the daemon package, which only runs inside guests). */
export const DAEMON_PORT = 7070;

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
