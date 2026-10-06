// SPDX-License-Identifier: AGPL-3.0-only
// The four words a person types about where their agents run: wsp add, which
// hands out a join line or takes a provider's key; wsp remove, which takes a
// place back out and sweeps wsp off it; wsp join, typed on the computer they
// are sitting at, which dials the host once and then serves the link under
// this computer's own service manager; and wsp leave, the sweep run on a
// computer whose host is gone, which wsp remove cannot reach.
//
// add and remove speak to the host on this computer, at the address its lock
// names and with the token it wrote beside its state file, so neither is a
// road a paired client or an agent can reach: a join code hands out access.
// join and leave touch this computer's own files and dial nobody's host but
// the one the person typed.

import { homedir } from "node:os";
import { keyFingerprint } from "@wsp/engine";
import type { PlaceWiring } from "@wsp/runtime";
import { placeBackHolder } from "./place-back.js";
import { hostPlatform } from "./verbs.js";
import { collect, nodeHost } from "@wsp/collect";
import { readBrewTable } from "./init-brew.js";
import { placeProvisioner } from "./place-provision.js";
import { hostNameHere, hostPlaceKey, placeHere } from "./places/this-computer.js";
import { placeDialler, placeInstaller, placeLeaver, placeLogReader, placeRunner, placeSudoReader, placeUndoer, placeUpdater, vaultGitHubToken } from "./places/install.js";
export * from "./places/this-computer.js";
export * from "./places/add-words.js";
export * from "./places/install.js";
export * from "./places/commands.js";
export * from "./places/join.js";

/** What a host wires for its places: its own pair and this computer's own row. The provider row is the runtime's,
 * read off the provider pick a saved key moves. */
export function placeWiring(statePath: string, advertise?: string): PlaceWiring {
  const hostKey = hostPlaceKey(statePath);
  // One holder for the installer and the records: the forward an add stood is the one the record keeps.
  const back = placeBackHolder({ hostKey: keyFingerprint(hostKey.publicKey) });
  return {
    hostKey,
    back,
    // A computer's picks, planned off this computer by the same two readers a copy of the image is planned from,
    // since a box is set up from the same rows by the same roads.
    provision: placeProvisioner({
      statePath,
      home: homedir(),
      platform: hostPlatform(),
      collect: () => collect(nodeHost()),
      brew: () => readBrewTable(nodeHost()),
    }),
    // The word the person gave --advertise travels to the install, which is the one road that knows the computer
    // being joined is somewhere else and so whether that word could ever be dialled from it.
    install: placeInstaller({ back, ...(advertise === undefined ? {} : { advertise }) }),
    dial: placeDialler(),
    log: placeLogReader(),
    update: placeUpdater(),
    leave: placeLeaver(),
    sudoOver: placeSudoReader(),
    runOver: placeRunner(),
    undo: placeUndoer(),
    githubToken: () => vaultGitHubToken(statePath),
    hostName: hostNameHere,
    // This computer under the name a person would type for it, and what it is off the same read a place sends about
    // itself, so the row for the computer the host runs on carries the facts every other row carries.
    here: () => placeHere(),
  };
}
