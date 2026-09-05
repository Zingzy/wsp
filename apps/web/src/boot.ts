// SPDX-License-Identifier: AGPL-3.0-only
import type { BootPayload } from "@wsp/protocol";

/** The boot object the host wrote into the page, or undefined where no host served it (tests). */
export function bootPayload(): BootPayload | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as { __WSP__?: BootPayload }).__WSP__;
}
