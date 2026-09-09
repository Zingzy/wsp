// SPDX-License-Identifier: AGPL-3.0-only
import { loadKeys, makeRuntime, servesNothing, type Keys, type KeySources } from "@wsp/host";
import { isLocalWorkspace, type WorkspaceView } from "@wsp/protocol";
import type { Runtime } from "@wsp/runtime";

export type Setup = { ready: true; runtime: Runtime } | { ready: false };

export interface SetupOptions {
  statePath: string;
  sources?: KeySources;
  runtimeFor?: (keys: Keys, statePath: string) => Runtime;
}

const silent = { log: (): void => {}, error: (): void => {} };
const refuse = (q: string): Promise<string> => Promise.reject(new Error(`this window asks nothing: ${q}`));

/** The bin's lookup order (env, ./.env, ~/.wsp/.env) with nothing asked: this window has no terminal, and a missing
 * provider key is not a missing answer here, it is the road on which this computer alone is the workspace. */
async function findKeys(sources?: KeySources): Promise<Keys> {
  return loadKeys({ ...silent, ask: refuse, askSecret: refuse }, sources, { anthropic: false, noSolari: "local" });
}

/** Ready means the state holds something to show: a golden with a head version to fork from, or any workspace
 * record, this computer's or a machine over ssh. That is the test wsp up applies, so a computer with no provider
 * key opens the window on the machines it does have. With nothing to show, this is the app's first launch, and the
 * runtime built to ask goes away rather than lingering behind the launch's own windows. */
export async function checkSetup(opts: SetupOptions): Promise<Setup> {
  const keys = await findKeys(opts.sources);
  const runtime = (opts.runtimeFor ?? makeRuntime)(keys, opts.statePath);
  if (!(await servesNothing(runtime))) return { ready: true, runtime };
  await runtime.close();
  return { ready: false };
}

/** The first launch's last step: this computer recorded as the one local workspace, the road wsp new --local takes,
 * over a runtime the window then serves. With or without a provider key: the cloud is what a person adds later, and
 * adding it never blocks what they have. A record already there is the one kept. */
export async function recordThisComputer(opts: SetupOptions): Promise<{ runtime: Runtime; workspace: WorkspaceView }> {
  const keys = await findKeys(opts.sources);
  const runtime = (opts.runtimeFor ?? makeRuntime)(keys, opts.statePath);
  try {
    const workspace = (await runtime.workspaces.list()).find(isLocalWorkspace) ?? (await runtime.workspaces.createLocal());
    return { runtime, workspace };
  } catch (e) {
    await runtime.close();
    throw e;
  }
}
