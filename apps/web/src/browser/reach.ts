// SPDX-License-Identifier: AGPL-3.0-only
// The public route for the port a browser tab shows, asked of the runtime and
// asked again before it expires so the frame never sits on a dead token.
import { useEffect, useState } from "react";
import type { PortReachView } from "@wsp/protocol";
import { useStore } from "../protocol/store.js";

/** Ask again with this much of the hour left. The runtime hands the cached
 * route back while more than ten minutes remain (its refresh margin), so
 * asking with nine is what makes it remint. A route that stands only while the
 * pane keeps asking, a port forwarded from a computer the person joined, is
 * asked again halfway through instead. */
export const REACH_REFRESH_WITH_MS_LEFT = 9 * 60_000;

/** Never re-ask sooner than this: expiresAt is the host's clock and Date.now()
 * the browser's, so a browser running ahead would otherwise compute a zero
 * delay and hammer the socket while the runtime returns the same cached route. */
export const REACH_REASK_FLOOR_MS = 30_000;

export type PortReach =
  | { state: "minting" }
  | { state: "ready"; reach: PortReachView }
  | { state: "failed"; error: string };

type Minted = { workspaceId: string; port: number } & ({ reach: PortReachView } | { error: string });

/** A new `again` asks again at once: a fresh route after the edge refused a token, a reload of a route that failed, a fetch
 * of the port that failed. */
export function usePortReach(workspaceId: string, port: number | null, again = ""): PortReach {
  const api = useStore(s => s.api);
  const [minted, setMinted] = useState<Minted | null>(null);

  useEffect(() => {
    if (!api || port === null) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (): void => {
      api.portReach(workspaceId, port).then(
        reach => {
          if (gone) return;
          setMinted({ workspaceId, port, reach });
          const left = reach.expiresAt - Date.now();
          timer = setTimeout(ask, Math.max(REACH_REASK_FLOOR_MS, left - Math.min(REACH_REFRESH_WITH_MS_LEFT, left / 2)));
        },
        (e: unknown) => {
          if (!gone) setMinted({ workspaceId, port, error: e instanceof Error ? e.message : String(e) });
        },
      );
    };
    ask();
    return () => {
      gone = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, workspaceId, port, again]);

  if (port === null || minted === null || minted.workspaceId !== workspaceId || minted.port !== port) return { state: "minting" };
  return "reach" in minted ? { state: "ready", reach: minted.reach } : { state: "failed", error: minted.error };
}
