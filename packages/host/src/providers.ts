// SPDX-License-Identifier: AGPL-3.0-only
// Every machine provider this computer can be set up for, in one table: what
// selects each, the variable it reads its key from and the module it builds.
// The rows are read in order and the first that this computer answers to wins,
// so a person who names a provider gets it and a person who names none gets
// whatever their keys and their daemon say they have. Adding a provider is a
// row here and its backend in the engine; nothing above this file compares a
// provider by name.

import { BoxBackend, DockerBackend, FakeBackend, NoProviderBackend, SolariBackend, type MachineBackend } from "@wsp/engine";
import { SOLARI_CONSOLE } from "@wsp/protocol";
import { keyIn } from "./env-keys.js";

/** The environment a provider is picked out of: the host's own, with whatever the command line's provider words put
 * in front of it and every registered row's key variable filled from the layers a key is read through. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export interface ProviderModule {
  /** The word `--provider` takes and WSP_PROVIDER holds. */
  id: string;
  /** The variables this row selects on, so a host that starts with none of the installing shell's environment can
   * be handed them: `wsp up --service` copies whichever of them that shell held into the unit. Keys are not among
   * them: they stay out of a unit file, and the host reads them off the same .env at every start. */
  envNames: readonly string[];
  /** A row that is a place a person adds by naming it and nothing else: `wsp add docker` is the whole of it. A row
   * that reads a key is a place too, opened by that key, and says so by declaring keyEnv rather than a second time
   * here; a row that is no place at all declares neither. */
  addedByWords?: true;
  /** The variable this row reads its key from. Every layer a key is read through fills it, and the screen that
   * asks for a key says where to put it by this name. A row that needs no key names none, and names no key words
   * either: the two are declared together or not at all. */
  keyEnv?: string;
  /** That key in a person's words, which is what the screen asking for it is titled. */
  keyName?: string;
  /** Where a person gets that key, said on the screen that asks for it. */
  keyConsole?: string;
  /** Whether this computer is set up for this provider. */
  selects(env: ProviderEnv): boolean;
  build(env: ProviderEnv): MachineBackend;
}

/** The variable a person names a provider in, for a host started by a service or a window where no flag can reach. */
export const PROVIDER_ENV = "WSP_PROVIDER";
/** The shorthand for the Docker row, so a shell that already has DOCKER_HOST needs one word more. */
export const DOCKER_ENV = "WSP_DOCKER";
/** The daemon the Docker row dials, as the docker CLI's own variable words it. */
export const DOCKER_HOST_ENV = "DOCKER_HOST";
/** The Box by ASCII key. */
export const BOX_KEY_ENV = "BOX_API_KEY";
/** The Solari key. */
export const SOLARI_KEY_ENV = "SOLARI_API_KEY";

const on = (value: string | undefined): boolean => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

export const PROVIDER_MODULES: readonly ProviderModule[] = [
  {
    id: "docker",
    // A daemon socket rather than a key: the words pick it and the socket is the person's own to point at.
    addedByWords: true,
    envNames: [PROVIDER_ENV, DOCKER_ENV, DOCKER_HOST_ENV],
    // Named, or asked for by the shorthand. A person who names Docker gets it even with a cloud key saved: the
    // machines are on their own box and the key is for another provider's.
    selects: env => env[PROVIDER_ENV] === "docker" || on(env[DOCKER_ENV]),
    build: env => new DockerBackend({ ...(env[DOCKER_HOST_ENV] !== undefined ? { host: env[DOCKER_HOST_ENV] } : {}) }),
  },
  {
    id: "box",
    envNames: [PROVIDER_ENV],
    keyEnv: BOX_KEY_ENV,
    keyName: "Box API key",
    // Named alone: the word says which cloud this computer forks on, and a missing key is asked for by its own
    // variable on the key screen rather than guessed at here.
    selects: env => env[PROVIDER_ENV] === "box",
    build: env => new BoxBackend({ apiKey: env[BOX_KEY_ENV] ?? "" }),
  },
  {
    id: "fake",
    // No way of being added, so `wsp add` takes neither the word nor a key for it and `wsp places` shows no row:
    // a provider that answers out of memory is a harness's fixture and never a place somebody owns.
    envNames: [PROVIDER_ENV],
    // Named and never guessed: a provider that answers out of memory is what a harness serves a fixture state
    // through, so it is reached by asking for it by name and by nothing else. Two roads beyond a harness reach it,
    // both starting with the word typed: `wsp up --service` copies WSP_PROVIDER out of the installing shell into
    // the unit, and `wsp init --provider fake` would seal a hollow golden, since these machines answer exit 0 to
    // everything and the smoke gate reads an exit code.
    selects: env => env[PROVIDER_ENV] === "fake",
    build: () => new FakeBackend(),
  },
  {
    id: "solari",
    envNames: [PROVIDER_ENV],
    keyEnv: SOLARI_KEY_ENV,
    keyName: "Solari API key",
    keyConsole: SOLARI_CONSOLE,
    // Named, or taken by its key alone: this is the cloud a computer that names no provider is offered, so a key
    // saved on its own is the whole answer.
    selects: env => env[PROVIDER_ENV] === "solari" || keyIn(env, SOLARI_KEY_ENV) !== undefined,
    build: env => new SolariBackend({ apiKey: env[SOLARI_KEY_ENV] ?? "" }),
  },
  {
    id: "none",
    // No machine behind it, so no place to add and none to show: it is the row that refuses every road in one line.
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

/** How a person adds this provider as a place, and nothing where it is no place at all: a row that reads a key is
 * opened by that key, and a row that is a place without one says so on the row. `wsp add` reads this for which
 * words it takes and whether to put a key to the provider, `wsp places` reads it for whether the row is a place to
 * show, and neither compares an id. One reading off the row's own facts, so a row cannot declare that it takes a
 * key and then be added without one. */
export function addedBy(m: ProviderModule): "key" | "words" | undefined {
  return m.keyEnv !== undefined ? "key" : m.addedByWords === true ? "words" : undefined;
}

/** The providers a person can add as a place, in the table's own order: every row that answers for how it is added.
 * Read off the table, so a provider added tomorrow is on `wsp add`'s line without anyone editing that line. */
export function addedProviders(modules: readonly ProviderModule[] = PROVIDER_MODULES): ProviderModule[] {
  return modules.filter(m => addedBy(m) !== undefined);
}

/** Every variable a row reads its key from, each once: what the layers a key is read through fill. */
export function providerKeyEnvs(modules: readonly ProviderModule[] = PROVIDER_MODULES): string[] {
  return [...new Set(modules.flatMap(m => (m.keyEnv !== undefined ? [m.keyEnv] : [])))];
}

/** The provider module this computer is set up for. */
export function providerModule(env: ProviderEnv, modules: readonly ProviderModule[] = PROVIDER_MODULES): ProviderModule {
  return modules.find(m => m.selects(env))!;
}

export function providerBackendFor(env: ProviderEnv): MachineBackend {
  return providerModule(env).build(env);
}

/** Stands for any key at all, so a row can be asked which one it would be wired by without one being typed first. */
const ANY_KEY = "?";

/** The row a key typed on this computer is put to: the picked row when it reads a key, and otherwise the row that
 * holding a key would make the pick, so a computer set up for no provider is still offered the cloud a key alone
 * wires. Nothing when this computer is set up for a provider that reads no key. */
export function providerKeyRow(env: ProviderEnv, modules: readonly ProviderModule[] = PROVIDER_MODULES): ProviderModule | undefined {
  const picked = providerModule(env, modules);
  if (picked.keyEnv !== undefined) return picked;
  return modules.find(m => m.keyEnv !== undefined && providerModule({ ...env, [m.keyEnv]: ANY_KEY }, modules) === m);
}

/** The environment a key typed on this computer is checked in: under the variable the row that would take it reads,
 * so the provider the run is wired to is the one the key is put to. */
export function providerEnvWithKey(env: ProviderEnv, key: string): ProviderEnv {
  const row = providerKeyRow(env);
  return row?.keyEnv === undefined ? env : { ...env, [row.keyEnv]: key };
}

/** The environment a run picks its provider out of: the host's own, the command line's words in front, and every
 * registered key variable taken from the first layer that holds it. With no layers given the environment is the
 * only one there is, which is what a host started by a service reads. */
export function providerEnvWith(
  flags: { provider?: string; dockerHost?: string },
  env: ProviderEnv = process.env,
  layers: readonly ProviderEnv[] = [env],
): ProviderEnv {
  const keys = providerKeyEnvs().flatMap(name => {
    const value = layers.map(l => keyIn(l, name)).find(v => v !== undefined);
    return value !== undefined ? [[name, value] as const] : [];
  });
  return {
    ...env,
    ...Object.fromEntries(keys),
    ...(flags.provider !== undefined ? { [PROVIDER_ENV]: flags.provider } : {}),
    ...(flags.dockerHost !== undefined ? { [DOCKER_HOST_ENV]: flags.dockerHost } : {}),
  };
}
