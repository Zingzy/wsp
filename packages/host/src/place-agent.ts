// SPDX-License-Identifier: AGPL-3.0-only
// What `wsp join --serve` runs on a computer somebody joined: the daemon in
// this process, as a local workspace's is, plus the link it dials its host on.
// Nothing here binds an address anything off this computer can reach: the
// daemon is on loopback and the host is reached by the socket this process
// opened outward.
//
// It is reached by a dynamic import and never by an eager one: @wsp/daemon
// dlopens node-pty's native module at import, and nothing that merely imports
// @wsp/host may load that. The rule is stated at doctor.ts's OPEN_SHIM_PATH.

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { homedir } from "node:os";
import { PlaceLink, portSourceFor, startDaemon, type DaemonHandle } from "@wsp/daemon";
import { LOOPBACK, placeDaemonPaths, workFolderIn } from "@wsp/protocol";
import { holdWhileJoined } from "./awake.js";
import { placeReport, stopPlaceService, sweepPlace } from "./place-report.js";
import { machineOps } from "./place-machines.js";
import { offeredBackend } from "./place-offers.js";
import { type RunningWsp } from "./mcp-install.js";

export interface PlaceAgentOptions {
  /** The place file this agent reads its host and its key off, on every attempt. */
  file: string;
  /** The name the host knows this computer by, off that file. */
  name: string;
  home?: string;
  log?: (line: string) => void;
  run?: RunningWsp;
  /** How often the place file is read again for the awake toggle; the app writes the file and nothing restarts. */
  watchEveryMs?: number;
}

export interface PlaceAgent {
  /** The port the daemon bound on this computer's loopback. */
  port: number;
  link: PlaceLink;
  close(): Promise<void>;
}

/** The agent `wsp join --serve` is: the daemon in this process on loopback with a token minted fresh at every
 * start, and the link that dials the host. The host replaces that token through the ordinary rotation on its first
 * reach, which is the road every other daemon's token takes. */
export async function startPlaceAgent(opts: PlaceAgentOptions): Promise<PlaceAgent> {
  const home = opts.home ?? homedir();
  const at = placeDaemonPaths(home);
  const work = workFolderIn(home);
  mkdirSync(at.inbox, { recursive: true, mode: 0o700 });
  mkdirSync(work, { recursive: true });
  const awake = holdWhileJoined({ file: opts.file, ...(opts.log !== undefined ? { log: opts.log } : {}), ...(opts.watchEveryMs !== undefined ? { intervalMs: opts.watchEveryMs } : {}) });
  // Read once, before the first dial: the report says what this computer can fork with, and the ops the link
  // answers are that same backend's, so the host is never told of a road nothing here serves.
  const offer = await offeredBackend();
  const token = randomBytes(24).toString("hex");
  mkdirSync(at.wsp, { recursive: true, mode: 0o700 });
  writeFileSync(at.tokenPath, `${token}\n`, { mode: 0o600 });
  // Loopback only: nothing on this computer's network has any business on its daemon, and the host reaches it over
  // the socket this process opened outward.
  const handle: DaemonHandle = await startDaemon({
    host: LOOPBACK,
    port: 0,
    tokenPath: at.tokenPath,
    kind: "place",
    root: home,
    workFolder: work,
    inboxDir: at.inbox,
    rootsPath: at.rootsPath,
    manifest: { path: at.manifestPath },
    portsSource: portSourceFor(platform()),
    link: {
      file: opts.file,
      report: async () => placeReport({ name: opts.name, home, docker: offer !== undefined, ...(opts.run !== undefined ? { run: opts.run } : {}) }),
      ...(offer === undefined ? {} : { ops: machineOps(offer.id, offer.backend, at.putDir) }),
      // The files and the unit file go here; the manager is asked to let this process go only after the reply is on
      // the wire, since the thing it stops is this process.
      onLeave: async () => {
        // The hold goes with the place: a computer that has left runs nobody's threads, and the child would
        // otherwise outlive the agent's own exit.
        awake.stop();
        return (await sweepPlace({ home })).removed;
      },
      exit: () => void stopPlaceService({ home }).finally(() => process.exit(0)),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
    },
  });
  // The daemon writes the port it bound where every other daemon of wsp's does, so the forward the panes ride
  // reads one file whichever road put the daemon there.
  writeFileSync(at.portFile, `${handle.port}\n`, { mode: 0o600 });
  if (handle.link === undefined) throw new Error("the place agent started without a link, so nothing would dial its host");
  return {
    port: handle.port,
    link: handle.link,
    close: async () => {
      awake.stop();
      await handle.close();
    },
  };
}
