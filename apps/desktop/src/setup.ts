// SPDX-License-Identifier: AGPL-3.0-only
import { goldenRecipe, keySources, loadKeys, makeRuntime, readOnce, servesNothing, type Keys, type KeySources, type LoadedKeys, type ProviderEnv } from "@wsp/host";
import { isLocalWorkspace, type WorkspaceView } from "@wsp/protocol";
import type { Runtime, Store } from "@wsp/runtime";

export type Setup = { ready: true; runtime: Runtime } | { ready: false };

export interface SetupOptions {
  statePath: string;
  sources?: KeySources;
  runtimeFor?: (keys: Keys, statePath: string, env: ProviderEnv, store: Store) => Runtime;
}

const silent = { log: (): void => {}, error: (): void => {} };
const refuse = (q: string): Promise<string> => Promise.reject(new Error(`this window asks nothing: ${q}`));

/** The bin's lookup order (the environment, ./.env, the .env beside the state file this window serves) with
 * nothing asked: this window has no terminal, and a missing provider key is not a missing answer here, it is the
 * road on which this computer alone is the workspace. */
async function findKeys(statePath: string, sources?: KeySources): Promise<LoadedKeys> {
  return loadKeys({ ...silent, ask: refuse, askSecret: refuse }, sources ?? keySources(process.env, statePath), { anthropic: false, noSolari: "local" });
}

/** The state file read once before anything is made, then the runtime this window serves over: the provider picked
 * out of the environment the keys were read through, so a key in the .env beside that state file wires the same
 * module here as it does at a terminal. The read comes first for the reason readOnce carries, so an app of an older
 * build opened on a state of a newer shape refuses with nothing minted, and the store it answers is handed on. */
async function runtimeOf(opts: SetupOptions): Promise<Runtime> {
  const store = await readOnce(opts.statePath);
  const loaded = await findKeys(opts.statePath, opts.sources);
  const build = opts.runtimeFor ?? ((keys, path, env, over) => makeRuntime(keys, path, goldenRecipe(), env, undefined, undefined, undefined, over));
  return build(loaded.keys, opts.statePath, loaded.env, store);
}

/** Ready means the state holds something to show: a golden with a head version to fork from, or any workspace
 * record, this computer's or a machine over ssh. That is the test wsp up applies, so a computer with no provider
 * key opens the window on the machines it does have. With nothing to show, this is the app's first launch, and the
 * runtime built to ask goes away rather than lingering behind the launch's own windows. */
export async function checkSetup(opts: SetupOptions): Promise<Setup> {
  const runtime = await runtimeOf(opts);
  try {
    if (!(await servesNothing(runtime))) return { ready: true, runtime };
  } catch (e) {
    await runtime.close();
    throw e;
  }
  await runtime.close();
  return { ready: false };
}

/** The first launch's last step: the runtime the window then serves, and the workspace on this computer where one
 * already stands. A workspace is one project's copy, so this launch records none: the person names a folder and the
 * work it is for, and the app opens on whatever they have until the first-run screen that asks for both lands. */
export async function openThisComputer(opts: SetupOptions): Promise<{ runtime: Runtime; workspace: WorkspaceView | null }> {
  const runtime = await runtimeOf(opts);
  try {
    return { runtime, workspace: (await runtime.workspaces.list()).find(isLocalWorkspace) ?? null };
  } catch (e) {
    await runtime.close();
    throw e;
  }
}
