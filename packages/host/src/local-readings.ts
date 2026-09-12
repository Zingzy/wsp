// SPDX-License-Identifier: AGPL-3.0-only
// This computer's own cpu, memory and disk, read in the host process. The
// workspace that is this computer is the one whose machine the host is
// already sitting on, so its Live rows need no port, no token and no link:
// the readings module the local kind answers with (os, df and the memory road
// the platform answers honestly on) runs here, and the rows stand whether or
// not this computer's daemon ever started. One sampler however many panes are
// open; it starts with the first listener and stops with the last.
import { platform } from "node:os";
import type { SysSample } from "@wsp/protocol";
import { startOnce } from "./start-once.js";

export interface LocalReadingsOptions {
  /** The folder paths resolve inside, as this computer's daemon reads it: the person's home. */
  root: string;
  /** The folder turns write in, whose volume the disk row reads. Asked for when the first pane opens, not when the
   * host is built: asking makes the folder, and a computer nobody has set up is left as it was. */
  workFolder: () => string;
  /** How often the machine is read; the sampler's own default (two seconds) is what a pane's window is drawn at. */
  intervalMs?: number;
}

/** Subscribes to this computer's readings, built on the first listener. The daemon package is loaded here rather
 * than at the top of the host, as the local daemon is, so a host nobody opens a pane on loads none of it; a build
 * that failed is let go of and said once, by the one rule the daemon's own start reads. */
export function localSysSamples(opts: LocalReadingsOptions): (fn: (s: SysSample) => void) => Promise<() => void> {
  const sampler = startOnce(
    async () => {
      const m = await import("@wsp/daemon");
      return new m.SysSampler(m.readingsFor("local").metrics({ root: opts.root, workFolder: opts.workFolder(), ports: m.portSourceFor(platform()) }), {
        ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
      });
    },
    why => `this computer's own load could not be read, so the Live rows of its workspace wait: ${why}`,
  );
  return async fn => (await sampler.get()).subscribe(fn);
}
