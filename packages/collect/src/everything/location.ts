// SPDX-License-Identifier: AGPL-3.0-only
// Pass 2b. An entry directly under a config location is named for the program
// that owns it. One named for a command line tool, or for a macOS app under
// ~/.config or ~/.local/share, is that program's config. One under ~/Library
// named for a macOS app, or for nothing at all, is app data, which no Linux
// machine reads. One under ~/.config named for nothing stays unknown.
import { type Machine, basename, dirname } from "./host.js";
import type { Owner, Provenance } from "./provenance.js";

export type Place = { kind: "config"; tool: string; owner?: Owner; binary?: string } | { kind: "app-data"; tool?: string };

interface Bin {
  name: string;
  owner?: Owner;
  package?: string;
  path?: string;
}

/** Every program a name can match, by key. */
export interface Programs {
  bins: Map<string, Bin>;
  /** Display name: what /Applications lists, else the cask or App Store name. */
  apps: Map<string, string>;
  tools: Map<string, string>;
}

/** Lowercase letters and digits only, so GitKrakenCLI matches gitkraken-cli and iTerm2 matches iterm2. */
export const key = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A reverse-DNS name: com.docker.install, org.mozilla.firefox. */
export const isBundleId = (name: string): boolean => /^[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9.-]+$/i.test(name);

export function configRoots(home: string): string[] {
  return [`${home}/.config`, `${home}/.local/share`, `${home}/Library/Application Support`, `${home}/Library/Preferences`];
}

export async function programs(m: Machine, prov: Provenance, tools: Iterable<string>, apps: Iterable<string>): Promise<Programs> {
  const bins = new Map<string, Bin>();
  for (const t of prov.tools) {
    if (t.owner === "system") continue;
    for (const k of [key(t.name), ...(t.package === undefined ? [] : [key(t.package)])]) {
      if (k !== "" && !bins.has(k)) bins.set(k, { name: t.name, owner: t.owner, ...(t.package === undefined ? {} : { package: t.package }) });
    }
  }
  for (const l of prov.leftovers) if (!bins.has(key(l.name))) bins.set(key(l.name), { name: l.name, path: l.path });
  const named = new Map<string, string>();
  for (const dir of ["/Applications", `${m.home}/Applications`]) {
    for (const n of await m.fs.list(dir)) if (n.endsWith(".app")) named.set(key(n.slice(0, -4)), n.slice(0, -4));
  }
  for (const a of apps) if (!named.has(key(a))) named.set(key(a), a);
  const rung = new Map<string, string>();
  for (const t of tools) if (!rung.has(key(t))) rung.set(key(t), t);
  return { bins, apps: named, tools: rung };
}

/** What an entry directly under a config location is, by its name; undefined when it is somewhere else, or nothing is named like it and it is not under ~/Library. */
export function place(home: string, path: string, kind: "file" | "dir", p: Programs): Place | undefined {
  const parent = dirname(path);
  if (!configRoots(home).includes(parent)) return undefined;
  const name = basename(path);
  // GUI apps never use dot names; a dot-directory under ~/Library is a command line tool's.
  const library = parent.startsWith(`${home}/Library/`) && !name.startsWith(".");
  if (library && isBundleId(name)) return { kind: "app-data" };
  const id = key(kind === "file" ? name.replace(/\.[^.]+$/, "") : name);
  const bin = id === "" ? undefined : p.bins.get(id);
  if (bin !== undefined) {
    if (bin.owner === "app") return library ? { kind: "app-data", tool: bin.package ?? bin.name } : { kind: "config", tool: bin.package ?? bin.name, owner: "app" };
    return { kind: "config", tool: bin.name, ...(bin.owner === undefined ? {} : { owner: bin.owner }), ...(bin.path === undefined ? {} : { binary: bin.path }) };
  }
  const app = id === "" ? undefined : p.apps.get(id);
  if (app !== undefined) return library ? { kind: "app-data", tool: app } : { kind: "config", tool: app };
  const tool = id === "" ? undefined : p.tools.get(id);
  if (tool !== undefined) return { kind: "config", tool };
  return library ? { kind: "app-data" } : undefined;
}
