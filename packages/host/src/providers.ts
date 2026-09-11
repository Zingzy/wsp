// SPDX-License-Identifier: AGPL-3.0-only
// Every machine provider this computer can be set up for, in one table: what
// selects each and the module it builds. The rows are read in order and the
// first that this computer answers to wins, so a person who names a provider
// gets it and a person who names none gets whatever their keys and their
// daemon say they have. Adding a provider is a row here and its backend in the
// engine; nothing above this file compares a provider by name.

import { DockerBackend, NoProviderBackend, SolariBackend, type MachineBackend } from "@wsp/engine";
import type { Keys } from "./env-keys.js";

/** The environment a provider is picked out of: the host's own, with whatever the command line's provider words put
 * in front of it. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export interface ProviderPick {
  keys: Keys;
  env: ProviderEnv;
}

export interface ProviderModule {
  /** The word `--provider` takes and WSP_PROVIDER holds. */
  id: string;
  /** The variables this row reads, so a host that starts with none of the installing shell's environment can be
   * handed them: `wsp up --service` copies whichever of them that shell held into the unit. A row that selects on
   * keys alone names none. */
  envNames: readonly string[];
  /** Whether this computer is set up for this provider. */
  selects(pick: ProviderPick): boolean;
  build(pick: ProviderPick): MachineBackend;
}

/** The variable a person names a provider in, for a host started by a service or a window where no flag can reach. */
export const PROVIDER_ENV = "WSP_PROVIDER";
/** The shorthand for the Docker row, so a shell that already has DOCKER_HOST needs one word more. */
export const DOCKER_ENV = "WSP_DOCKER";
/** The daemon the Docker row dials, as the docker CLI's own variable words it. */
export const DOCKER_HOST_ENV = "DOCKER_HOST";

const on = (value: string | undefined): boolean => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

export const PROVIDER_MODULES: readonly ProviderModule[] = [
  {
    id: "docker",
    envNames: [PROVIDER_ENV, DOCKER_ENV, DOCKER_HOST_ENV],
    // Named, or asked for by the shorthand. A person who names Docker gets it even with a cloud key saved: the
    // machines are on their own box and the key is for another provider's.
    selects: pick => pick.env[PROVIDER_ENV] === "docker" || on(pick.env[DOCKER_ENV]),
    build: pick => new DockerBackend({ ...(pick.env[DOCKER_HOST_ENV] !== undefined ? { host: pick.env[DOCKER_HOST_ENV] } : {}) }),
  },
  {
    id: "solari",
    envNames: [],
    // Selected by the key alone: the word without a key would build a module that refuses every call with a 401,
    // where the row below says what to do about it in one sentence.
    selects: pick => pick.keys.solari !== undefined,
    build: pick => new SolariBackend({ apiKey: pick.keys.solari! }),
  },
  {
    id: "none",
    envNames: [],
    selects: () => true,
    build: () => new NoProviderBackend(),
  },
];

/** Every variable the rows select on, each once: what a service carries over from the shell that installed it, so
 * a provider added tomorrow travels with its row rather than with a list somebody remembered to edit. */
export function providerEnvNames(modules: readonly ProviderModule[] = PROVIDER_MODULES): string[] {
  return [...new Set(modules.flatMap(m => m.envNames))];
}

/** The provider module this computer is set up for. */
export function providerModule(pick: ProviderPick): ProviderModule {
  return PROVIDER_MODULES.find(m => m.selects(pick))!;
}

export function providerBackendFor(pick: ProviderPick): MachineBackend {
  return providerModule(pick).build(pick);
}

/** The environment a run picks its provider out of: the host's own, with the command line's words in front. */
export function providerEnvWith(flags: { provider?: string; dockerHost?: string }, env: ProviderEnv = process.env): ProviderEnv {
  return {
    ...env,
    ...(flags.provider !== undefined ? { [PROVIDER_ENV]: flags.provider } : {}),
    ...(flags.dockerHost !== undefined ? { [DOCKER_HOST_ENV]: flags.dockerHost } : {}),
  };
}
