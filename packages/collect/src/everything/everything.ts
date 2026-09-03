// SPDX-License-Identifier: AGPL-3.0-only
// Runs the seven passes in order and folds them into rows. Everything comes
// back unticked; a credential is a flag for the person, never a default.
import { credentials } from "./credentials.js";
import { sizeGate } from "./gate.js";
import { type Machine, basename, tilde } from "./host.js";
import { keychain, serviceOwner } from "./keychain.js";
import { pair } from "./pairing.js";
import { binaryNames, provenance } from "./provenance.js";
import { roles } from "./roles.js";
import { type Kind, type Row, Rows } from "./row.js";
import { type RcScan, shellRc } from "./shell-rc.js";
import { EMPTY, type Tree, add } from "./walk.js";

/** The app a directory name belongs to, or undefined when the catalog has never heard of it. */
export type NameLookup = (dirName: string) => string | undefined;
export const noLookup: NameLookup = () => undefined;

export interface EverythingOptions {
  lookup?: NameLookup;
  /** Epoch ms the stale check counts back from; tests pin it. */
  now?: number;
}

export interface Everything {
  rows: Row[];
  /** Pass 6: rc files with secret exports, names only, plus the copy to carry. */
  shell: RcScan[];
}

const TWO_YEARS = 2 * 365.25 * 86_400_000;

function row(name: string, kind: Kind, paths: string[], t: Tree, owner?: string): Row {
  return { name, kind, paths, bytes: t.bytes, files: t.files, mtime: t.mtime, ...(owner !== undefined ? { owner } : {}), flags: [], ticked: false };
}

function flag(r: Row, f: Row["flags"][number]): void {
  if (!r.flags.includes(f)) r.flags.push(f);
}

export async function everything(m: Machine, opts: EverythingOptions = {}): Promise<Everything> {
  const lookup = opts.lookup ?? noLookup;
  const now = opts.now ?? Date.now();
  const prov = await provenance(m);
  const dirs = await roles(m);
  const { pairs, rest } = pair(m.home, prov, dirs);
  const creds = await credentials(m, dirs);
  const items = await keychain(m);
  const shell = await shellRc(m);

  const rows: Row[] = [];
  for (const p of pairs) {
    let tree = p.dirs.reduce<Tree>((t, d) => add(t, d), EMPTY);
    const paths = p.dirs.flatMap(d => d.paths);
    if (p.binary !== undefined) {
      paths.unshift(p.binary.path);
      tree = add(tree, { bytes: p.binary.bytes, files: 1, mtime: p.binary.mtime });
    }
    rows.push(row(p.name, "config", paths, tree, p.owner));
  }

  for (const d of rest) {
    const hit = d.role === "unknown" ? lookup(basename(d.path)) : undefined;
    const r = row(hit ?? basename(d.path), hit !== undefined ? "config" : d.role, d.paths, d);
    if (d.role === "unknown" && d.mtime > 0 && now - d.mtime > TWO_YEARS) flag(r, "stale");
    rows.push(r);
  }

  const paired = new Set(pairs.map(p => p.binary?.name));
  for (const l of prov.leftovers) {
    if (!paired.has(l.name)) rows.push(row(l.name, "unknown", [l.path], { bytes: l.bytes, files: 1, mtime: l.mtime }));
  }

  for (const c of creds) {
    const own = rows.find(r => r.paths.includes(c.path));
    const parent = own ?? rows.find(r => r.paths.some(p => c.path.startsWith(`${p}/`)));
    if (own !== undefined) {
      own.kind = "credential";
      flag(own, "credential");
      continue;
    }
    if (parent !== undefined) {
      flag(parent, "credential");
      parent.bytes -= c.bytes;
      parent.files -= 1;
    }
    const r = row(basename(c.path), "credential", [c.path], { bytes: c.bytes, files: 1, mtime: c.mtime }, parent?.owner);
    flag(r, "credential");
    rows.push(r);
  }

  const bins = binaryNames(prov);
  for (const it of items) rows.push(row(it.service, "device-bound-login", [], EMPTY, serviceOwner(it.service, bins)));

  for (const r of rows) r.paths = r.paths.map(p => tilde(m.home, p));
  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.kind.localeCompare(b.kind));
  return { rows: Rows.parse(sizeGate(rows)), shell };
}
