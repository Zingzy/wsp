// SPDX-License-Identifier: AGPL-3.0-only
// Pass 3. A binary called foo owns ~/.config/foo, ~/.foo, ~/.local/share/foo
// and ~/.foorc. The pair is one row; only records nobody else has claimed
// take part, so a cache split out in pass 2 stays a cache.
import type { Leftover, Owner, Provenance, Tool } from "./provenance.js";
import type { Dir } from "./roles.js";

export interface Pair {
  name: string;
  owner?: Owner;
  /** The binary itself when nothing records how it was installed; the row carries it. */
  binary?: Leftover;
  dirs: Dir[];
}

export interface Pairing {
  pairs: Pair[];
  rest: Dir[];
}

export function candidates(home: string, name: string): string[] {
  return [`${home}/.config/${name}`, `${home}/.${name}`, `${home}/.local/share/${name}`, `${home}/.${name}rc`];
}

export function pair(home: string, prov: Provenance, dirs: Dir[]): Pairing {
  const free = new Map<string, Dir>();
  for (const d of dirs) if (d.role === "unknown") free.set(d.path, d);

  const take = (names: string[]): Dir[] => {
    const out: Dir[] = [];
    for (const n of names) {
      for (const c of candidates(home, n)) {
        const d = free.get(c);
        if (d === undefined) continue;
        free.delete(c);
        out.push(d);
      }
    }
    return out;
  };

  const pairs: Pair[] = [];
  const bins: (Tool | Leftover)[] = [...prov.tools, ...prov.leftovers];
  for (const b of bins) {
    const names = "package" in b && b.package !== undefined && b.package !== b.name ? [b.name, b.package] : [b.name];
    const taken = take(names);
    if (taken.length === 0) continue;
    const p: Pair = { name: b.name, dirs: taken };
    if ("owner" in b) p.owner = b.owner;
    else p.binary = b;
    pairs.push(p);
  }
  const claimed = new Set(pairs.flatMap(p => p.dirs));
  return { pairs, rest: dirs.filter(d => !claimed.has(d)) };
}
