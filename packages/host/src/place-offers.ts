// SPDX-License-Identifier: AGPL-3.0-only
// What a computer joined as a place can offer the wsp it belongs to. One table,
// one row per kind of backend a joined computer could serve, and adding a kind
// is a row here and its module: nothing else on either side of the link asks
// what a place runs. The agent reads this once at start, tells its host in the
// report what it found, and serves that one backend's ops on the link.

import { DockerBackend, type MachineBackend } from "@wsp/engine";

/** One kind of machine a joined computer can offer, and how it is built from that computer's own environment. */
export interface PlaceOffer {
  id: "docker";
  build(env: NodeJS.ProcessEnv): MachineBackend;
}

/** Every backend a joined computer can serve, in the order they are tried. */
export const PLACE_OFFERS: readonly PlaceOffer[] = [
  {
    id: "docker",
    // A machine idle on a computer somebody owns is stopped and not frozen: it holds no memory while it waits and
    // comes back off its own layers at the next send, so ten idle workspaces cost that computer nothing. The
    // freezer is for a machine that must keep what its processes hold, which is what a provider's own fork wants.
    build: env => new DockerBackend({ pauseMode: "disk", ...(env["DOCKER_HOST"] !== undefined ? { host: env["DOCKER_HOST"] } : {}) }),
  },
];

/** The first offer whose backend answers on this computer, or nothing when none does. One cheap read that boots no
 * machine, so a computer whose Docker is installed but not running offers nothing rather than failing at the first
 * fork. What the report says about Docker is this answer, so the report and the served backend cannot disagree. */
export async function offeredBackend(env: NodeJS.ProcessEnv = process.env, offers: readonly PlaceOffer[] = PLACE_OFFERS): Promise<{ id: PlaceOffer["id"]; backend: MachineBackend } | undefined> {
  for (const offer of offers) {
    const backend = offer.build(env);
    if (backend.checkKey === undefined) continue;
    try {
      await backend.checkKey();
      return { id: offer.id, backend };
    } catch {
      // A daemon that is not there, not running or not this login's: the next offer gets its turn, and a computer
      // where none answers serves no machine op at all.
    }
  }
  return undefined;
}
