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
import { type Dir, roleByName, roles } from "./roles.js";
import { type Kind, type Measured, type Row, Rows } from "./row.js";
import { type RcScan, shellRc } from "./shell-rc.js";
import { EMPTY, type Tree, add, budget, fileTree, linkTree, summarize } from "./walk.js";

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
  /** The records behind the row, for naming what is split out of them. */
  dirs: Dir[];
}

interface Claimed {
  paths: string[];
  services: Set<string>;
}

function row(id: string, name: string, kind: Kind, paths: string[], t: Tree, measured: Measured, extra: Partial<Pick<Row, "owner" | "binary" | "linkTarget" | "excludes">> = {}): Row {
  const r: Row = { id, name, kind, paths, excludes: extra.excludes ?? [], bytes: t.bytes, files: t.files, mtime: t.mtime, measured, flags: [], ticked: false };
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

/** What the record counted under path: nothing when a split name sits between them, a file's size, or a walk with the record's own skip rule. */
async function measure(m: Machine, d: Dir, path: string, clock: () => number): Promise<Tree> {
  const split = d.role === "unknown" && d.kind === "dir" && d.linkTarget === undefined;
  if (split && path.slice(d.path.length + 1).split("/").some(n => roleByName(n) !== undefined)) return EMPTY;
  const e = await m.fs.stat(path);
  if (e?.kind === "file") return fileTree(e);
  if (e?.kind === "link") return linkTree(e);
  if (e?.kind !== "dir") return EMPTY;
  return summarize(m.fs, path, { budget: budget(clock), ...(split ? { skip: (n: string) => roleByName(n) !== undefined } : {}) });
}

function subtract(t: Tree, e: Tree): Tree {
  return { bytes: Math.max(0, t.bytes - e.bytes), files: Math.max(0, t.files - e.files), mtime: t.mtime };
}

/** Takes a measured part off a record. A lower bound from which the part removes more than was counted, in bytes or in files, was never a count of what remains, so it becomes no measure at all. */
function take<T extends Tree & { measured: Measured }>(d: T, part: Tree): T {
  const t = subtract(d, part);
  const gone = d.measured === "lower-bound" && (t.files === 0 || part.bytes > d.bytes || part.files > d.files);
  return gone ? { ...d, ...EMPTY, mtime: d.mtime, measured: "none" } : { ...d, ...t };
}

/** Drops records and paths at or under a claimed path. A claimed path strictly inside a record comes off the record whose counted set holds it, the longest match; a claimed path under another claimed path is already gone with it. */
async function unclaimed(m: Machine, dirs: readonly Dir[], claimed: string[], clock: () => number): Promise<Dir[]> {
  const tops = claimed.filter(c => !claimed.some(o => o !== c && under(c, o)));
  const out: Dir[] = [];
  for (const d of dirs) {
    if (tops.some(c => under(d.path, c))) continue;
    const paths = d.paths.filter(p => !tops.some(c => under(p, c)));
    if (paths.length === 0) continue;
    let r: Dir = { ...d, paths, excludes: [...d.excludes] };
    for (const p of d.paths) if (!paths.includes(p)) r = take(r, await measure(m, d, p, clock));
    out.push(r);
  }
  for (const c of tops) {
    let hit: { i: number; p: string } | undefined;
    out.forEach((d, i) => { for (const p of d.paths) if (c !== p && under(c, p) && (hit === undefined || p.length > hit.p.length)) hit = { i, p }; });
    if (hit === undefined) continue;
    const d = out[hit.i];
    if (d === undefined) continue;
    const next = take(d, await measure(m, d, c, clock));
    out[hit.i] = { ...next, excludes: next.excludes.includes(c) ? next.excludes : [...next.excludes, c].sort() };
  }
  return out;
}

/** `<app dir>/<basename>`: the record's directory names what was split out of it or found inside it; a HOME dotfile keeps its own name. */
function inside(home: string, dirs: readonly Dir[], path: string): string {
  const d = dirs.find(x => under(path, x.path)) ?? dirs.find(x => x.paths.some(p => under(path, p)));
  const app = d === undefined ? dirname(path) : d.kind === "dir" ? d.path : dirname(d.path);
  return app === home || app === "" ? basename(path) : `${basename(app)}/${basename(path)}`;
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
  const bins = [...prov.tools, ...prov.leftovers];
  const binDirs = new Set(bins.flatMap(t => [dirname(t.path), dirname(t.resolved)]).filter(d => under(d, m.home) && d !== m.home));
  const binFiles = new Set(bins.flatMap(t => [t.path, t.resolved]).filter(f => under(f, m.home)));
  const dirs = await unclaimed(m, await roles(m, { clock, notes, binDirs, binFiles }), claimed.paths, clock);
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
  const items = (await keychain(m, { notes })).filter(it => !claimed.services.has(it.service));
  const shell = await shellRc(m, { notes });

  const drafts: Draft[] = [];
  for (const p of pairs) {
    const tree = p.dirs.reduce<Tree>((t, d) => add(t, d), EMPTY);
    const paths = p.dirs.flatMap(d => d.paths);
    const measured: Measured = p.dirs.some(d => d.measured === "lower-bound") ? "lower-bound" : "exact";
    const extra = { owner: p.owner, binary: p.binary === undefined ? undefined : tilde(m.home, p.binary.path), linkTarget: p.dirs[0]?.linkTarget, excludes: p.dirs.flatMap(d => d.excludes).sort() };
    drafts.push({ row: row(p.name, p.name, "config", paths, tree, measured, extra), named: true, dirs: p.dirs });
  }

  for (const d of rest) {
    const hit = d.role === "unknown" && d.kind === "dir" ? lookup(tilde(m.home, d.path))[0]?.app : undefined;
    const carved = d.paths[0] !== undefined && d.paths[0] !== d.path;
    const name = hit ?? (!carved ? basename(d.path) : d.paths.length > 1 ? `${basename(d.path)}/${d.role}` : inside(m.home, [d], d.paths[0] ?? d.path));
    const r = row(d.path, name, hit !== undefined ? "config" : d.role, d.paths, d, d.measured, { linkTarget: d.linkTarget, excludes: d.excludes });
    if (d.role === "unknown" && d.measured === "exact" && d.mtime > 0 && now - d.mtime > TWO_YEARS) flag(r, "stale");
    drafts.push({ row: r, named: hit !== undefined, dirs: [d] });
  }

  const leftover = (l: { name: string; path: string; mtime: number }): Draft => ({ row: row(`bin:${l.name}`, l.name, "unknown", [], { bytes: 0, files: 0, mtime: l.mtime }, "exact", { binary: tilde(m.home, l.path) }), named: true, dirs: [] });
  const paired = new Set(pairs.map(p => p.binary?.name));
  for (const l of prov.leftovers) if (!paired.has(l.name)) drafts.push(leftover(l));

  for (const c of [...creds.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const skip = isClaimed(c.path);
    const own = drafts.find(d => d.row.paths.length === 1 && d.row.paths[0] === c.path);
    if (own !== undefined) {
      own.row.kind = "credential";
      flag(own.row, "credential");
      if (!own.named && own.dirs[0]?.kind === "file") own.row.name = inside(m.home, own.dirs, c.path);
      continue;
    }
    let parent: Draft | undefined;
    let longest = -1;
    for (const d of drafts) {
      for (const p of d.row.paths) {
        if (under(c.path, p) && p.length > longest) {
          parent = d;
          longest = p.length;
        }
      }
    }
    if (parent !== undefined) {
      flag(parent.row, "credential");
      if (parent.row.paths.includes(c.path)) parent.row.paths = parent.row.paths.filter(p => p !== c.path);
      else if (!parent.row.excludes.includes(c.path)) parent.row.excludes = [...parent.row.excludes, c.path].sort();
      if (!skip) Object.assign(parent.row, take(parent.row, c));
    }
    if (skip) continue;
    const r = row(c.path, inside(m.home, parent?.dirs ?? [], c.path), "credential", [c.path], c, "exact", { owner: parent?.row.owner });
    flag(r, "credential");
    drafts.push({ row: r, named: false, dirs: parent?.dirs ?? [] });
  }
  for (const p of scan.partial) {
    const r = drafts.find(d => d.row.paths.includes(p))?.row;
    if (r !== undefined) flag(r, "partial");
  }

  const names = binaryNames(prov);
  for (const it of items) drafts.push({ row: row(`keychain:${it.service}`, it.service, "device-bound-login", [], EMPTY, "exact", { owner: serviceOwner(it.service, names) }), named: true, dirs: [] });

  const carries = (r: Row): boolean => r.paths.length > 0 && (r.files > 0 || r.measured !== "exact" || r.kind === "credential");
  const kept = drafts.flatMap(d => {
    const r = d.row;
    if (carries(r) || r.kind === "device-bound-login") return [d];
    if (r.binary === undefined) return [];
    return [leftover({ name: r.name, path: `${m.home}/${r.binary.slice(2)}`, mtime: r.mtime })];
  });
  for (const d of kept) {
    const primary = d.row.paths[0];
    if (primary !== undefined) d.row.id = rel(primary);
    d.row.paths = d.row.paths.map(p => tilde(m.home, p));
    d.row.excludes = d.row.excludes.filter(x => d.row.paths.some(p => under(x, `${m.home}/${p.slice(2)}`) && x !== `${m.home}/${p.slice(2)}`)).map(x => tilde(m.home, x));
    if (d.row.linkTarget !== undefined) d.row.linkTarget = tilde(m.home, d.row.linkTarget);
  }
  disambiguate(kept);
  const rows = kept.map(d => d.row);
  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { rows: Rows.parse(sizeGate(rows)), shell, notes };
}
