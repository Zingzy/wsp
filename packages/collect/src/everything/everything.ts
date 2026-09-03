// SPDX-License-Identifier: AGPL-3.0-only
// Runs the seven passes in order and folds them into rows. Everything comes
// back unticked; a credential is a flag for the person, never a default; a
// binary is named on its row and never put among the paths that travel.
import type { Lookup } from "../catalog.js";
import { type Credential, credentials } from "./credentials.js";
import { sizeGate } from "./gate.js";
import { type Machine, basename, dirname, tilde } from "./host.js";
import { keychain, serviceOwner } from "./keychain.js";
import { pair } from "./pairing.js";
import { binaryNames, provenance } from "./provenance.js";
import { type Dir, roles } from "./roles.js";
import { type Kind, type Measured, type Row, Rows } from "./row.js";
import { type RcScan, shellRc } from "./shell-rc.js";
import { EMPTY, type Tree, add, budget, summarize } from "./walk.js";

export const noLookup: Lookup = () => [];

export interface EverythingOptions {
  /** The catalog: what it says lives in a directory, each path flagged if it is a credential. */
  lookup?: Lookup;
  /** `~`-relative paths the rungs above already carry; rows and credentials at or under them are dropped. */
  claimed?: ReadonlySet<string>;
  /** Epoch ms the stale check counts back from; tests pin it. */
  now?: number;
  /** Monotonic ms for the walk budget; tests pin it. */
  clock?: () => number;
}

export interface Everything {
  rows: Row[];
  /** Pass 6: rc files with secret exports, names only, plus the copy to carry. */
  shell: RcScan[];
  /** What a pass skipped and why. */
  notes: string[];
}

const TWO_YEARS = 2 * 365.25 * 86_400_000;

interface Draft {
  row: Row;
  /** Named for a tool or an app rather than for its path; a collision does not rename it. */
  named: boolean;
}

function row(id: string, name: string, kind: Kind, paths: string[], t: Tree, measured: Measured, extra: Partial<Pick<Row, "owner" | "binary" | "linkTarget">> = {}): Row {
  const r: Row = { id, name, kind, paths, bytes: t.bytes, files: t.files, mtime: t.mtime, measured, flags: [], ticked: false };
  if (extra.owner !== undefined) r.owner = extra.owner;
  if (extra.binary !== undefined) r.binary = extra.binary;
  if (extra.linkTarget !== undefined) r.linkTarget = extra.linkTarget;
  return r;
}

function flag(r: Row, f: Row["flags"][number]): void {
  if (!r.flags.includes(f)) r.flags.push(f);
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Catalog paths flagged credential that exist under a record become credentials too; a directory is measured as one. */
async function catalogCredentials(m: Machine, dirs: readonly Dir[], lookup: Lookup, clock: () => number): Promise<Credential[]> {
  const out: Credential[] = [];
  for (const d of dirs) {
    if (d.role !== "unknown") continue;
    for (const hit of lookup(tilde(m.home, d.path))) {
      if (!hit.credential) continue;
      const abs = `${m.home}/${hit.path.slice(2)}`;
      const e = await m.fs.stat(abs);
      if (e?.kind === "file") out.push({ path: abs, bytes: e.bytes, files: 1, mode: e.mode, mtime: e.mtime, signals: ["catalog"] });
      if (e?.kind === "dir") {
        const t = abs === d.path ? d : await summarize(m.fs, abs, { budget: budget(clock) });
        out.push({ path: abs, ...t, mode: e.mode, signals: ["catalog"] });
      }
    }
  }
  return out;
}

/** In a group of rows sharing a name, the ones named for their own path keep it only when alone; split records and duplicates take their parent directory. */
function disambiguate(drafts: Draft[]): void {
  const groups = new Map<string, Draft[]>();
  for (const d of drafts) groups.set(d.row.name, [...(groups.get(d.row.name) ?? []), d]);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const own = group.filter(d => d.row.paths[0] !== undefined && d.row.name === basename(d.row.paths[0]));
    for (const d of group) {
      const primary = d.row.paths[0];
      if (d.named || primary === undefined) continue;
      if (own.includes(d) && own.length < 2) continue;
      const parent = dirname(primary);
      if (parent === "~") continue;
      d.row.name = `${basename(parent)}/${basename(primary)}`;
    }
  }
}

export async function everything(m: Machine, opts: EverythingOptions = {}): Promise<Everything> {
  const lookup = opts.lookup ?? noLookup;
  const now = opts.now ?? Date.now();
  const clock = opts.clock ?? Date.now;
  const claimed = [...(opts.claimed ?? [])].map(p => (p.startsWith("~/") ? `${m.home}/${p.slice(2)}` : `${m.home}/${p}`));
  const isClaimed = (abs: string): boolean => claimed.some(c => under(abs, c));
  const rel = (abs: string): string => tilde(m.home, abs).replace(/^~\//, "");

  const prov = await provenance(m);
  const dirs = (await roles(m, { clock })).flatMap(d => {
    if (isClaimed(d.path)) return [];
    const paths = d.paths.filter(p => !isClaimed(p));
    return paths.length === 0 ? [] : [{ ...d, paths }];
  });
  const { pairs, rest } = pair(m.home, prov, dirs);
  const scan = await credentials(m, dirs, { clock });
  const creds = new Map<string, Credential>();
  for (const c of [...scan.found, ...(await catalogCredentials(m, dirs, lookup, clock))]) {
    if (isClaimed(c.path)) continue;
    const prior = creds.get(c.path);
    if (prior === undefined) creds.set(c.path, c);
    else for (const s of c.signals) if (!prior.signals.includes(s)) prior.signals.push(s);
  }
  for (const c of creds.values()) {
    if ([...creds.keys()].some(k => k !== c.path && under(c.path, k))) creds.delete(c.path);
  }
  const items = await keychain(m);
  const shell = await shellRc(m);

  const drafts: Draft[] = [];
  for (const p of pairs) {
    const tree = p.dirs.reduce<Tree>((t, d) => add(t, d), EMPTY);
    const paths = p.dirs.flatMap(d => d.paths);
    const measured: Measured = p.dirs.some(d => d.measured === "lower-bound") ? "lower-bound" : "exact";
    const extra = { owner: p.owner, binary: p.binary === undefined ? undefined : tilde(m.home, p.binary.path), linkTarget: p.dirs[0]?.linkTarget };
    drafts.push({ row: row(rel(paths[0] ?? p.name), p.name, "config", paths, tree, measured, extra), named: true });
  }

  for (const d of rest) {
    const hit = d.role === "unknown" && d.kind === "dir" ? lookup(tilde(m.home, d.path))[0]?.app : undefined;
    const r = row(rel(d.paths[0] ?? d.path), hit ?? basename(d.path), hit !== undefined ? "config" : d.role, d.paths, d, d.measured, { linkTarget: d.linkTarget });
    if (d.role === "unknown" && d.measured === "exact" && d.mtime > 0 && now - d.mtime > TWO_YEARS) flag(r, "stale");
    drafts.push({ row: r, named: hit !== undefined });
  }

  const paired = new Set(pairs.map(p => p.binary?.name));
  for (const l of prov.leftovers) {
    if (!paired.has(l.name)) drafts.push({ row: row(`bin:${l.name}`, l.name, "unknown", [], { bytes: 0, files: 0, mtime: l.mtime }, "exact", { binary: tilde(m.home, l.path) }), named: true });
  }

  for (const c of [...creds.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const rows = drafts.map(d => d.row);
    const own = rows.find(r => r.paths.length === 1 && r.paths[0] === c.path);
    if (own !== undefined) {
      own.kind = "credential";
      flag(own, "credential");
      continue;
    }
    let parent: Row | undefined;
    let longest = -1;
    for (const r of rows) {
      for (const p of r.paths) {
        if (under(c.path, p) && p.length > longest) {
          parent = r;
          longest = p.length;
        }
      }
    }
    if (parent !== undefined) {
      flag(parent, "credential");
      parent.paths = parent.paths.filter(p => p !== c.path);
      parent.bytes = Math.max(0, parent.bytes - c.bytes);
      parent.files = Math.max(0, parent.files - c.files);
    }
    const r = row(rel(c.path), basename(c.path), "credential", [c.path], c, "exact", { owner: parent?.owner });
    flag(r, "credential");
    drafts.push({ row: r, named: false });
  }

  const bins = binaryNames(prov);
  for (const it of items) drafts.push({ row: row(`keychain:${it.service}`, it.service, "device-bound-login", [], EMPTY, "exact", { owner: serviceOwner(it.service, bins) }), named: true });

  for (const d of drafts) {
    d.row.paths = d.row.paths.map(p => tilde(m.home, p));
    if (d.row.linkTarget !== undefined) d.row.linkTarget = tilde(m.home, d.row.linkTarget);
  }
  disambiguate(drafts);
  const rows = drafts.map(d => d.row);
  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { rows: Rows.parse(sizeGate(rows)), shell, notes: scan.notes };
}
