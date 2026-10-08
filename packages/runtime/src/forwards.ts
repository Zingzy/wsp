// SPDX-License-Identifier: AGPL-3.0-only
// The port forwards the app lists and stops: the host's relay holds the ones a
// workspace's link names, and the runtime the ones a Browser pane opened for a
// folder on a computer the person joined. One list, one stop, one stream.
import type { ForwardEvent, PortForward } from "@wsp/protocol";

/** The port forwards a host holds, as the app lists and stops them. The host that owns the daemon links supplies its
 * relay's; the runtime adds the panes' own. */
export interface ForwardsSource {
  list(): PortForward[];
  /** True when a forward was open on that workspace and port and is now closed. */
  stop(workspaceId: string, port: number): boolean;
  on(fn: (e: ForwardEvent) => void): () => void;
}

/** Every source as one: listed together, stopped by whichever holds the forward, heard from each. */
export function forwardsOf(...sources: (ForwardsSource | undefined)[]): ForwardsSource {
  const held = sources.filter((s): s is ForwardsSource => s !== undefined);
  return {
    list: () => held.flatMap(s => s.list()),
    stop: (workspaceId, port) => held.some(s => s.stop(workspaceId, port)),
    on: fn => {
      const offs = held.map(s => s.on(fn));
      return () => {
        for (const off of offs) off();
      };
    },
  };
}
