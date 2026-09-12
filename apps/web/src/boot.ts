// SPDX-License-Identifier: AGPL-3.0-only
import type { BootPayload } from "@wsp/protocol";
import type { ConnStatus } from "./protocol/client.js";

/** The boot object the host wrote into the page, or undefined where no host served it (tests). */
export function bootPayload(): BootPayload | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as { __WSP__?: BootPayload }).__WSP__;
}

/** Whether this window is on a computer other than the one the wsp it shows runs on. A page served on loopback
 * carries the host's own token, since reaching it there already means being at that computer; a page served beyond
 * it carries none and holds a token of its own, which is the one reading the page has of being away. */
export function onAnotherComputer(): boolean {
  const boot = bootPayload();
  return boot !== undefined && boot.token === undefined;
}

/** Whether the computer the host runs on has gone quiet while this window watches from another one: its lid is
 * shut or it is off, and the workspaces on every other computer keep working. On the host's own computer a socket
 * that drops is wsp restarting, which the shell says in its own words. */
export function hostAsleep(conn: ConnStatus): boolean {
  return onAnotherComputer() && (conn === "closed" || conn === "reconnecting");
}
