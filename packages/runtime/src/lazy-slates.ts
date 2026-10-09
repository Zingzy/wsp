// SPDX-License-Identifier: AGPL-3.0-only
// The slate's code (its parser, kit, validator, runs and tools) is loaded the first time a thread uses a slate, or at
// start where one is stored so its timed runs recover then, so a host with no slate holds none of it.
import type { Slates, SlatesDeps } from "./slates.js";

/** The collection each thread's slate record is kept in, read here at start without loading the slate code. */
export const SLATES = "slates";

export function lazySlates(deps: SlatesDeps): Slates {
  let real: Slates | undefined;
  let loading: Promise<Slates> | undefined;
  const load = (): Promise<Slates> =>
    (loading ??= (async () => {
      const at = performance.now();
      const m = await import("./slates.js");
      real = m.createSlates(deps);
      console.log(`the slate's code loaded in ${Math.round(performance.now() - at)} ms`);
      return real;
    })());
  /** Once loaded, a call goes straight through, and while loading it waits its turn behind the calls before it, so a
   * turn's snapshot is taken before the next change lands as it was when nothing was lazy. */
  const used = <T>(f: (s: Slates) => T | Promise<T>): Promise<T> => (real !== undefined ? Promise.resolve(f(real)) : load().then(f));
  let stored: Promise<boolean> | undefined;
  /** As used, but while no slate was stored at start and none was used since, it answers none and loads nothing. */
  const ifAny = async <T>(f: (s: Slates) => T | Promise<T>, none: T): Promise<T> => {
    if (loading !== undefined) return used(f);
    return (await (stored ??= deps.store.list(SLATES).then(list => list.length > 0))) || loading !== undefined ? used(f) : none;
  };
  return {
    ready: () => ifAny(s => s.ready(), undefined),
    settled: async () => void (await (await loading)?.settled()),
    close: () => real?.close(),
    get: threadId => ifAny(s => s.get(threadId), null),
    write: (p, caller) => used(s => s.write(p, caller)),
    state: (p, caller) => used(s => s.state(p, caller)),
    read: (p, caller) => used(s => s.read(p, caller)),
    catalog: (p, caller) => used(s => s.catalog(p, caller)),
    shown: threadId => used(s => s.shown(threadId)),
    revoke: p => used(s => s.revoke(p)),
    event: p => used(s => s.event(p)),
    approve: p => used(s => s.approve(p)),
    cancel: p => used(s => s.cancel(p)),
    resolve: p => used(s => s.resolve(p)),
    image: p => used(s => s.image(p)),
    subscribe: p => {
      if (real !== undefined) return real.subscribe(p);
      let release: (() => void) | undefined;
      let released = false;
      void load().then(s => {
        if (!released) release = s.subscribe(p);
      });
      return () => {
        released = true;
        release?.();
      };
    },
    turnEnded: o => ifAny(s => s.turnEnded(o), undefined),
    rewound: o => ifAny(s => s.rewound(o), undefined),
    forget: threadId => ifAny(s => s.forget(threadId), undefined),
    watchesPr: workspaceId => real?.watchesPr(workspaceId) ?? false,
  };
}
