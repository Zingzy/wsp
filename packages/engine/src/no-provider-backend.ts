// SPDX-License-Identifier: AGPL-3.0-only
// The backend a host wires when this computer has no machine provider key:
// wsp init took the local road, so this computer is a workspace and nothing
// else exists to fork. It sits behind the same MachineBackend seam the Solari
// and local backends do, so nothing above the registry learns there is no
// provider; every capability is false, so every road that reads one refuses
// before it reaches here, and the roads that ask anyway get one sentence
// naming what to do rather than a provider's 401.

import { NO_PROVIDER_LINE } from "@wsp/protocol";
import type { Capabilities } from "@wsp/protocol";
import type { BackendPricing, Machine, MachineBackend, MachineState, SnapshotStoragePricing } from "./machine.js";

const NO_SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" };

const refuse = (): never => {
  throw new Error(NO_PROVIDER_LINE);
};

/** The provider module of a host with no provider key: it holds no machine, lists none, and refuses every road with
 * the one sentence that says how to get one. */
export class NoProviderBackend implements MachineBackend {
  readonly capabilities: Capabilities = {
    liveCloneForks: false,
    resize: false,
    replacesMachine: false, // nothing here forks, so there is no machine to hand a workspace in place of another
    previewUrls: false,
    signedUrls: false,
    containers: false,
    callbackRelay: false,
    diskSnapshots: false,
    snapshotListing: false,
    templates: false,
    sizes: [],
    kept: false,
  };

  readonly pricing: BackendPricing = {
    rateUsdPerHour: () => 0,
    defaultSize: { cpu: 0, memMb: 0 },
    snapshotStorage: NO_SNAPSHOT_STORAGE,
  };

  async create(): Promise<Machine> {
    return refuse();
  }

  async get(): Promise<Machine> {
    return refuse();
  }

  async list(): Promise<{ id: string; state: MachineState; labels: Record<string, string> }[]> {
    return [];
  }

  async deleteSnapshot(): Promise<void> {
    return refuse();
  }
}
