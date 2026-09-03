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
import { EMPTY, type Tree, add, budget, fileTree, summarize } from "./walk.js";

export const noLookup: Lookup = () => [];

export interface EverythingOptions {
  /** The catalog: what it says lives in a directory, each path flagged if it is a credential. */
  lookup?: Lookup;
  /** What the rungs above already carry: `~/x`, bare `x`, the absolute path under HOME, or `Keychain: <service>`. Rows and credentials at or under a path are dropped; anything else throws. */
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
  /** What a pass skipped or could not finish, and why. */
  notes: string[];
}

const TWO_YEARS = 2 * 365.25 * 86_400_000;

interface Draft {
  row: Row;
  /** Named for a tool or an app rather than for its path; a collision does not rename it. */
  named: boolean;
}

interface Claimed {
  paths: string[];
  services: Set<string>;
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

function parseClaimed(home: string, entries: Iterable<string>): Claimed {
  const out: Claimed = { paths: [], services: new Set() };
  for (const raw of entries) {
    const kc = /^keychain:\s*(.+)$/i.exec(raw);
    if (kc?.[1] !== undefined) {
      out.services.add(kc[1].trim());
      continue;
    }
    const e = raw.replace(/\/+$/, "");
    if (e === "" || e === "~") throw new Error(`claimed entry "${raw}" names HOME itself or nothing`);
    if (e.startsWith("~/")) out.paths.push(`${home}/${e.slice(2)}`);
    else if (e.startsWith(`${home}/`)) out.paths.push(e);
    else if (e.startsWith("/")) throw new Error(`claimed entry "${raw}" is outside HOME`);
    else out.paths.push(`${home}/${e}`);
  }
  return out;
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

/** The size of a file or tree at path, for taking a claimed path off the record that counted it. */
async function measure(m: Machine, path: string, clock: () => number): Promise<Tree> {
  const e = await m.fs.stat(path);
  if (e?.kind === "file") return fileTree(e);
  if (e?.kind === "dir") return summarize(m.fs, path, { budget: budget(clock) });
  return EMPTY;
}

function subtract(t: Tree, e: Tree): Tree {
  return { bytes: Math.max(0, t.bytes - e.bytes), files: Math.max(0, t.files - e.files), mtime: t.mtime };
}

/** Drops records the rungs above carry. A claimed path comes off the record whose counted set holds it, the longest match, and a split record loses the path itself. */
async function unclaimed(m: Machine, dirs: readonly Dir[], claimed: string[], clock: () => number): Promise<Dir[]> {
  const out = dirs.filter(d => !claimed.some(c => under(d.path, c))).map(d => ({ ...d, paths: [...d.paths] }));
  for (const c of claimed) {
    let hit: { d: Dir; p: string } | undefined;
    for (const d of out) for (const p of d.paths) if (under(c, p) && (hit === undefined || p.length > hit.p.length)) hit = { d, p };
    if (hit === undefined) continue;
    if (hit.p === c) hit.d.paths = hit.d.paths.filter(p => p !== c);
    Object.assign(hit.d, subtract(hit.d, await measure(m, c, clock)));
  }
  return out.filter(d => d.paths.length > 0);
}

/** Rows sharing a name climb their parents, one level per round, until no name is shared; a row named for its own path keeps it when it is the only such row in its group. */
function disambiguate(drafts: Draft[]): void {
  const depth = new Map<Draft, number>();
  const segments = (d: Draft): string[] => (d.row.paths[0] ?? "").replace(/^~\//, "").split("/");
  for (let round = 0; round < 32; round += 1) {
    const groups = new Map<string, Draft[]>();
    for (const d of drafts) groups.set(d.row.name, [...(groups.get(d.row.name) ?? []), d]);
    let changed = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const own = group.filter(d => d.row.paths[0] !== undefined && d.row.name === basename(d.row.paths[0]));
      for (const d of group) {
        if (d.named || d.row.paths[0] === undefined || (own.includes(d) && own.length < 2)) continue;
        const k = (depth.get(d) ?? 1) + 1;
        if (k > segments(d).length) continue;
        depth.set(d, k);
        d.row.name = segments(d).slice(-k).join("/");
        changed = true;
      }
    }
    if (!changed) return;
  }
}

export async function everything(m: Machine, opts: EverythingOptions = {}): Promise<Everything> {
  const lookup = opts.lookup ?? noLookup;
  const now = opts.now ?? Date.now();
  const clock = opts.clock ?? Date.now;
  const claimed = parseClaimed(m.home, opts.claimed ?? []);
  const isClaimed = (abs: string): boolean => claimed.paths.some(c => under(abs, c));
  const rel = (abs: string): string => tilde(m.home, abs).replace(/^~\//, "");
  const notes: string[] = [];

  const prov = await provenance(m);
  const dirs = await unclaimed(m, await roles(m, { clock, notes }), claimed.paths, clock);
  const { pairs, rest } = pair(m.home, prov, dirs);
  const scan = await credentials(m, dirs, { clock });
  notes.push(...scan.notes);
  const creds = new Map<string, Credential>();
  for (const c of [...scan.found, ...(await catalogCredentials(m, dirs, lookup, clock))]) {
    const prior = creds.get(c.path);
    if (prior === undefined) creds.set(c.path, c);
    else for (const s of c.signals) if (!prior.signals.includes(s)) prior.signals.push(s);
  }
  for (const c of creds.values()) {
    if ([...creds.keys()].some(k => k !== c.path && under(c.path, k))) creds.delete(c.path);
  }
  const items = (await keychain(m)).filter(it => !claimed.services.has(it.service));
  const shell = await shellRc(m);

  const drafts: Draft[] = [];
  for (const p of pairs) {
    const tree = p.dirs.reduce<Tree>((t, d) => add(t, d), EMPTY);
    const paths = p.dirs.flatMap(d => d.paths);
    const measured: Measured = p.dirs.some(d => d.measured === "lower-bound") ? "lower-bound" : "exact";
    const extra = { owner: p.owner, binary: p.binary === undefined ? undefined : tilde(m.home, p.binary.path), linkTarget: p.dirs[0]?.linkTarget };
    drafts.push({ row: row(p.name, p.name, "config", paths, tree, measured, extra), named: true });
  }

  for (const d of rest) {
    const hit = d.role === "unknown" && d.kind === "dir" ? lookup(tilde(m.home, d.path))[0]?.app : undefined;
    const r = row(d.path, hit ?? basename(d.path), hit !== undefined ? "config" : d.role, d.paths, d, d.measured, { linkTarget: d.linkTarget });
    if (d.role === "unknown" && d.measured === "exact" && d.mtime > 0 && now - d.mtime > TWO_YEARS) flag(r, "stale");
    drafts.push({ row: r, named: hit !== undefined });
  }

  const paired = new Set(pairs.map(p => p.binary?.name));
  for (const l of prov.leftovers) {
    if (!paired.has(l.name)) drafts.push({ row: row(`bin:${l.name}`, l.name, "unknown", [], { bytes: 0, files: 0, mtime: l.mtime }, "exact", { binary: tilde(m.home, l.path) }), named: true });
  }

  for (const c of [...creds.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const rows = drafts.map(d => d.row);
    const skip = isClaimed(c.path);
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
      if (!skip) Object.assign(parent, subtract(parent, c));
    }
    if (skip) continue;
    const r = row(c.path, basename(c.path), "credential", [c.path], c, "exact", { owner: parent?.owner });
    flag(r, "credential");
    drafts.push({ row: r, named: false });
  }
  for (const p of scan.partial) {
    const r = drafts.find(d => d.row.paths.includes(p))?.row;
    if (r !== undefined) flag(r, "large");
  }

  const bins = binaryNames(prov);
  for (const it of items) drafts.push({ row: row(`keychain:${it.service}`, it.service, "device-bound-login", [], EMPTY, "exact", { owner: serviceOwner(it.service, bins) }), named: true });

  const kept = drafts.filter(d => {
    const r = d.row;
    if (r.paths.length === 0) return r.binary !== undefined || r.kind === "device-bound-login";
    return r.files > 0 || r.measured !== "exact" || r.kind === "credential";
  });
  for (const d of kept) {
    const primary = d.row.paths[0];
    if (primary !== undefined) d.row.id = rel(primary);
    d.row.paths = d.row.paths.map(p => tilde(m.home, p));
    if (d.row.linkTarget !== undefined) d.row.linkTarget = tilde(m.home, d.row.linkTarget);
  }
  disambiguate(kept);
  const rows = kept.map(d => d.row);
  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { rows: Rows.parse(sizeGate(rows)), shell, notes };
}
