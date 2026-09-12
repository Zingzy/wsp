// SPDX-License-Identifier: AGPL-3.0-only
// The guest a stand-in provider's machines get when a harness names a folder
// for them. One folder per machine standing in for its disk, with the same
// daemon this computer's own workspace runs rooted in it, so a fixture's fork
// has a terminal, a process list, live readings and browsable files instead of
// six ways of saying unreachable.
//
// It is wired from here and not from the stand-in itself for two reasons. The
// daemon package runs inside guests and the engine never imports it, so nothing
// down there can start one. And a stand-in that started a guest whether or not
// anybody asked would be a provider running a tester's commands on the person's
// computer by default: the folder has to be named, and a harness names one
// inside the throwaway home it serves out of.
//
// The daemon reads its token from a file in that folder rather than holding one
// this process minted, because the runtime rotates a machine's token by writing
// it through the machine's own exec, and that exec is a shell in this folder:
// nothing here can write the path a real fork's guest keeps it at. One file per
// process, since every process that dials a machine writes its own token there
// and a machine's folder is the one thing two of them share.
//
// Every daemon started here is held so the command that started it can take it
// away again: a child whose pipes this process reads is a reason it stays, and
// a command whose work was done printed its whole report and never returned to
// the prompt. The host serving the app is held up by its own ports, so closing
// these when a command ends costs it nothing.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FakeGuest } from "@wsp/engine";
import { DAEMON_PORT } from "@wsp/engine";
import { standInMachinePath, type PreviewReach } from "@wsp/protocol";
import { LocalDaemon } from "./local-daemon.js";

/** A loopback road has no edge token and no expiry; the field is the shape every reach arrives in. */
const NO_EDGE_TOKEN = "";
const NEVER = Number.MAX_SAFE_INTEGER;

/** One guest per folder, so a provider module built twice over one root does not put two daemons on one machine. */
const GUESTS = new Map<string, FakeGuest>();

/** Every daemon this process started for a stand-in machine, so all of them go when its command is done. */
const STARTED: Promise<LocalDaemon>[] = [];

/** The file one process's daemon for one stand-in machine reads its token from. The process is in the name because
 * a machine's folder is shared and its token is not: the runtime writes its own token there at every first reach,
 * and two of them on one file left the host serving the app holding a token its own daemon had stopped reading, so
 * a tester who typed a second verb watched the terminal, the files and the live rows go dark until it restarted. */
export const standInTokenPath = (root: string, machineId: string, of: number): string => join(standInMachinePath(root, machineId), `.wsp-daemon-token-${of}`);

/** What a road asking for any other port of a stand-in machine is told: nothing of the person's is behind it, and
 * answering with this computer's own loopback at that port would frame whatever they happen to be running. */
export const fakeNoPortLine = (machineId: string, port: number): string =>
  `nothing is listening on port ${port} of ${machineId}: this is a stand-in machine, and the only port behind it is its own daemon's`;

/** The guest for one folder: a machine's commands run in its folder there and its daemon is started at the first
 * road asked for, so a host nobody opens a pane on binds no port. */
export function fakeGuestAt(root: string): FakeGuest {
  const held = GUESTS.get(root);
  if (held !== undefined) return held;
  const started = new Map<string, Promise<LocalDaemon>>();
  const folder = (machineId: string): string => standInMachinePath(root, machineId);
  const tokenPath = (machineId: string): string => standInTokenPath(root, machineId, process.pid);
  const daemonOn = (machineId: string): Promise<LocalDaemon> => {
    const running = started.get(machineId);
    if (running !== undefined) return running;
    const starting = (async () => {
      const at = folder(machineId);
      mkdirSync(at, { recursive: true });
      return LocalDaemon.start({ root: at, workFolder: at, tokenPath: tokenPath(machineId) });
    })();
    started.set(machineId, starting);
    STARTED.push(starting);
    return starting;
  };
  const guest: FakeGuest = {
    folder,
    tokenPath,
    reach: async (machineId: string, port: number): Promise<PreviewReach> => {
      if (port !== DAEMON_PORT) throw new Error(fakeNoPortLine(machineId, port));
      const daemon = await daemonOn(machineId);
      return { url: daemon.road.url, token: NO_EDGE_TOKEN, expiresAt: NEVER };
    },
  };
  GUESTS.set(root, guest);
  return guest;
}

/** Closes every daemon this process started for a stand-in machine. The command that ran is what calls this: a
 * listening socket keeps a process alive, and a verb that dialled one of these machines printed everything it had
 * to say and then sat there. A host that is serving never reaches this, since its own command does not return. */
export async function closeStandInGuests(): Promise<void> {
  const held = STARTED.splice(0);
  GUESTS.clear();
  await Promise.all(held.map(starting => starting.then(daemon => daemon.close(), () => {})));
}
