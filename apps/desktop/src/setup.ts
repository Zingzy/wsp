// SPDX-License-Identifier: AGPL-3.0-only
import { loadKeys, makeRuntime, servesNothing, type Keys, type KeySources } from "@wsp/host";
import { forksNoMachines } from "@wsp/protocol";
import type { Runtime } from "@wsp/runtime";

export type Setup = { ready: true; runtime: Runtime } | { ready: false; missing: "key" | "golden" };

export interface SetupOptions {
  statePath: string;
  sources?: KeySources;
  runtimeFor?: (keys: Keys, statePath: string) => Runtime;
}

const silent = { log: (): void => {}, error: (): void => {} };
const refuse = (q: string): Promise<string> => Promise.reject(new Error(`this window asks nothing: ${q}`));

/** The bin's lookup order (env, ./.env, ~/.wsp/.env) with nothing asked: onboarding belongs to wsp init in a
 * terminal, never to this window. A missing provider key is not a missing answer here; it is wsp init's local road,
 * which this window opens on like any other. */
async function findKeys(sources?: KeySources): Promise<Keys> {
  return loadKeys({ ...silent, ask: refuse, askSecret: refuse }, sources, { anthropic: false, noSolari: "local" });
}

/** Ready means the state holds something to show: a golden with a head version to fork from, or any workspace
 * record, this computer's or a machine over ssh. That is the test wsp up applies, so a computer with no provider
 * key opens the window on the machines it does have. With nothing to show, the missing piece names which
 * onboarding is wanted, and the runtime built to ask goes away rather than lingering behind a closed window. */
export async function checkSetup(opts: SetupOptions): Promise<Setup> {
  const keys = await findKeys(opts.sources);
  const runtime = (opts.runtimeFor ?? makeRuntime)(keys, opts.statePath);
  if (!(await servesNothing(runtime))) return { ready: true, runtime };
  await runtime.close();
  // Which onboarding is wanted is read off the provider module the runtime wired, never off a key: a computer that
  // forks nothing needs wsp init's local road, and one that forks needs a golden sealed.
  return { ready: false, missing: forksNoMachines(runtime.backend.capabilities) ? "key" : "golden" };
}
