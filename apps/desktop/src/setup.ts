// SPDX-License-Identifier: AGPL-3.0-only
import { loadKeys, makeRuntime, type Keys, type KeySources } from "@wsp/host";
import type { Runtime } from "@wsp/runtime";

export type Setup = { ready: true; runtime: Runtime } | { ready: false; missing: "key" | "golden" };

export interface SetupOptions {
  statePath: string;
  sources?: KeySources;
  runtimeFor?: (keys: Keys, statePath: string) => Runtime;
}

class NoKey extends Error {}
const silent = { log: (): void => {}, error: (): void => {} };

/** The bin's lookup order (env, ./.env, ~/.wsp/.env) with its prompt refused:
 * onboarding belongs to wsp init in a terminal, never to this window. */
async function findKeys(sources?: KeySources): Promise<Keys | undefined> {
  const refuse = (): Promise<string> => Promise.reject(new NoKey());
  try {
    return await loadKeys({ ...silent, ask: refuse, askSecret: refuse }, sources);
  } catch (e) {
    if (e instanceof NoKey) return undefined;
    throw e;
  }
}

/** Ready means a Solari key is on disk and the store holds a golden with a
 * head version, the same test the host's workspace route applies. */
export async function checkSetup(opts: SetupOptions): Promise<Setup> {
  const keys = await findKeys(opts.sources);
  if (keys === undefined) return { ready: false, missing: "key" };
  const runtime = (opts.runtimeFor ?? makeRuntime)(keys, opts.statePath);
  const manifest = await runtime.golden.get();
  const head = manifest?.versions.find(v => v.version === manifest.head);
  return head !== undefined ? { ready: true, runtime } : { ready: false, missing: "golden" };
}
