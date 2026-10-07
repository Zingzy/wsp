// SPDX-License-Identifier: AGPL-3.0-only
// What a loopback link in a reply opens. A thread in a folder on a computer the
// person joined names that computer's ports: the link opens in a Browser tab of
// that thread, which forwards the port to this computer for as long as it shows
// it. Everywhere else a link opens as it is, so nothing here is provided.
import { createContext } from "react";
import { parseAddress, type Address } from "./url.js";

/** Takes a link the reply holds and answers whether it opened it itself; null opens every link as it is. */
export const LoopbackLinks = createContext<((href: string) => boolean) | null>(null);

/** The opener for one workspace: a link to a loopback address opens that port and path in a Browser tab; any other
 * link is left to open as it is. */
export function openInBrowser(open: (address: Address) => void): (href: string) => boolean {
  return href => {
    const at = /^https?:\/\//i.test(href) ? parseAddress(href) : null;
    if (at === null) return false;
    open(at);
    return true;
  };
}
