// SPDX-License-Identifier: AGPL-3.0-only
// The catalog is data shipped next to the package: mackup's application list
// converted to JSON (GPL-3.0-or-later, see data/NOTICE), wsp's own entries in
// the same shape, and an overlay naming which catalog paths are credentials.
// `lookup` answers "what does the catalog say lives in this directory".
import { readFileSync } from "node:fs";
import { z } from "zod";

const Entry = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** `$HOME`-relative, no leading `~/`. */
  paths: z.array(z.string()),
  /** `$XDG_CONFIG_HOME`-relative. */
  xdg: z.array(z.string()),
});
export type CatalogEntry = z.infer<typeof Entry>;

const EntryFile = z.object({ entries: z.array(Entry) });

const Overlay = z.object({
  /** `$HOME`-relative patterns; `*` matches within one path segment. */
  paths: z.array(z.string()),
  /** Basename patterns, same glob rules. */
  names: z.array(z.string()),
});
export type CredentialOverlay = z.infer<typeof Overlay>;

export interface CatalogPath {
  app: string;
  /** `~/`-relative, the form the rest of the collector uses. */
  path: string;
  credential: boolean;
}

/** Parses one mackup `.cfg` the way Python's configparser does with allow_no_value and optionxform=str. */
export function parseMackupCfg(id: string, text: string): CatalogEntry {
  let section = "";
  let name = id;
  const paths: string[] = [];
  const xdg: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }
    const delim = line.search(/[=:]/);
    const key = (delim === -1 ? line : line.slice(0, delim)).trim();
    const value = delim === -1 ? "" : line.slice(delim + 1).trim();
    if (section === "application" && key === "name") name = value;
    else if (section === "configuration_files") paths.push(key);
    else if (section === "xdg_configuration_files") xdg.push(key);
  }
  return { id, name, paths, xdg };
}

/** A macOS-only entry has paths only under `Library/`; on Linux there is nothing to find. */
export function isMacOnly(e: CatalogEntry): boolean {
  return e.xdg.length === 0 && e.paths.every(p => p.startsWith("Library/"));
}

export interface MackupCatalog {
  source: string;
  commit: string;
  license: string;
  notice: string;
  dropped: string[];
  entries: CatalogEntry[];
}

/** Converts a mackup checkout's cfg files into the shipped catalog, sorted by id, macOS-only entries dropped. */
export function convertMackup(cfgs: readonly { id: string; text: string }[], commit: string): MackupCatalog {
  const parsed = cfgs.map(c => parseMackupCfg(c.id, c.text)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    source: "https://github.com/lra/mackup",
    commit,
    license: "GPL-3.0-or-later",
    notice: "Converted from mackup's src/mackup/applications/*.cfg; the notice and license text are in NOTICE next to this file.",
    dropped: parsed.filter(isMacOnly).map(e => e.id),
    entries: parsed.filter(e => !isMacOnly(e)),
  };
}

/** One entry per line so a re-sync diff reads one app per hunk. */
export function renderCatalog(c: MackupCatalog): string {
  const { entries, ...header } = c;
  const head = JSON.stringify(header, null, 2).slice(0, -2);
  return `${head},\n  "entries": [\n${entries.map(e => `    ${JSON.stringify(e)}`).join(",\n")}\n  ]\n}\n`;
}

const STRIPPED_PREFIXES = ["~/", "Library/Application Support/", "Library/Preferences/", ".local/share/", ".config/"];

/** The directory name the collector walks: `.aws`, `gh` (under ~/.config), `Code` (under Application Support). */
export function dirKey(path: string): string {
  let p = path;
  for (const prefix of STRIPPED_PREFIXES) if (p.startsWith(prefix)) p = p.slice(prefix.length);
  const slash = p.indexOf("/");
  return slash === -1 ? p : p.slice(0, slash);
}

const globs = new Map<string, RegExp>();

function glob(pattern: string, s: string): boolean {
  let re = globs.get(pattern);
  if (re === undefined) {
    re = new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
    globs.set(pattern, re);
  }
  return re.test(s);
}

/** A path is a credential when it, a parent of it, or a file inside it matches the overlay. */
export function isCredential(rel: string, overlay: CredentialOverlay): boolean {
  const lineage: string[] = [];
  for (let p = rel; p !== ""; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") lineage.push(p);
  if (overlay.paths.some(pat => pat.startsWith(`${rel}/`) || lineage.some(a => glob(pat, a)))) return true;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return overlay.names.some(pat => glob(pat, base));
}

export type Lookup = (dirName: string) => CatalogPath[];

/** Builds the lookup over any entry lists; the shipped data goes through `lookup` below. */
export function buildLookup(entries: readonly CatalogEntry[], overlay: CredentialOverlay): Lookup {
  const index = new Map<string, Map<string, CatalogPath>>();
  for (const e of entries) {
    for (const rel of [...e.paths, ...e.xdg.map(x => `.config/${x}`)]) {
      const key = dirKey(rel);
      let bucket = index.get(key);
      if (bucket === undefined) {
        bucket = new Map();
        index.set(key, bucket);
      }
      const path = `~/${rel}`;
      if (!bucket.has(path)) bucket.set(path, { app: e.name, path, credential: isCredential(rel, overlay) });
    }
  }
  return dirName => [...(index.get(dirKey(dirName))?.values() ?? [])];
}

function readData<T>(file: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8")));
}

let shipped: Lookup | undefined;

/** Catalog paths for a directory name, `~/`-relative, each flagged if the overlay calls it a credential. Empty on a miss. */
export function lookup(dirName: string): CatalogPath[] {
  if (shipped === undefined) {
    const entries = [...readData("catalog.json", EntryFile).entries, ...readData("wsp-entries.json", EntryFile).entries];
    shipped = buildLookup(entries, readData("credential-overlay.json", Overlay));
  }
  return shipped(dirName);
}
