// SPDX-License-Identifier: AGPL-3.0-only
// Pass 3. A binary called foo owns ~/.config/foo, ~/.foo, ~/.local/share/foo
// and ~/.foorc. The pair is one row; only records nobody else has claimed
// take part, so a cache split out in pass 2 stays a cache. A system binary
// owns nothing: its files belong to the identity and shell rungs.
import type { Leftover, Owner, Provenance, Tool } from "./provenance.js";
import type { Dir } from "./roles.js";

export interface Pair {
  /** The binary or package name whose files were found; a package name wins when the directory is named after it. */
  name: string;
  owner?: Owner;
  /** The binary itself when nothing records how it was installed; the row names it and never copies it. */
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

  const take = (names: string[]): { name: string; dirs: Dir[] } | undefined => {
    let matched: string | undefined;
    const out: Dir[] = [];
    for (const n of names) {
      for (const c of candidates(home, n)) {
        const d = free.get(c);
        if (d === undefined) continue;
        free.delete(c);
        out.push(d);
        matched ??= n;
      }
    }
    return matched === undefined ? undefined : { name: matched, dirs: out };
  };

  const pairs: Pair[] = [];
  const bins: (Tool | Leftover)[] = [...prov.tools.filter(t => t.owner !== "system"), ...prov.leftovers];
  for (const b of bins) {
    const names = "package" in b && b.package !== undefined && b.package !== b.name ? [b.name, b.package] : [b.name];
    const taken = take(names);
    if (taken === undefined) continue;
    const p: Pair = { name: taken.name, dirs: taken.dirs };
    if ("owner" in b) p.owner = b.owner;
    else p.binary = b;
    pairs.push(p);
  }
  const claimed = new Set(pairs.flatMap(p => p.dirs));
  return { pairs, rest: dirs.filter(d => !claimed.has(d)) };
}
