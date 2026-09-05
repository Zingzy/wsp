// SPDX-License-Identifier: AGPL-3.0-only
// The everything rung as manifest rows: what the passes found under HOME
// that no rung claimed, one entry per row, none ticked. The screen groups
// them by where they sit, the pack copies paths minus excludes, and a
// credential-shaped row travels only on the person's own answer.
import { isBundleId } from "./everything/location.js";
import type { Kind, Manager, Row } from "./everything/row.js";
import type { ManifestEntry } from "./manifest.js";

export const APP_DATA_GROUP = "macOS app data, not for a Linux machine";
export const LARGE_GROUP = "large, review";
export const KEYCHAIN_GROUP = "Keychain, device-bound";
export const BY_HAND_GROUP = "installed by hand";

const KEYCHAIN_REASON = "signed in here; the login is bound to this device, sign in on the machine";
const BY_HAND_REASON = "installed by hand; reinstall it on the machine";
const APP_DATA_WHY = "nothing on a Linux machine reads it";

const ROLE_WORDS: Record<Kind, string> = {
  config: "looks like config",
  state: "state the program rebuilds",
  cache: "cache, rebuilt on use",
  credential: "credential-shaped",
  "device-bound-login": KEYCHAIN_REASON,
  "app-data": `data of a macOS app; ${APP_DATA_WHY}`,
  unknown: "nothing says what this is",
};

/** What rungs 1 to 7 already carry: their `~/` paths and Keychain items. A list row (a formula, a Go module) names no file. */
export function claimedPaths(entries: readonly Pick<ManifestEntry, "rung" | "paths">[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.rung === "tools" || e.rung === "everything") continue;
    for (const p of e.paths) if (p.startsWith("~/") || /^keychain:/i.test(p)) out.add(p);
  }
  return out;
}

const APP_IDS = ["brew-cask", "mas"];

/** The tools rung's names for the location pass: command line tools, and the macOS apps among them. */
export function rungPrograms(entries: readonly Pick<ManifestEntry, "rung" | "id">[]): { tools: string[]; apps: string[] } {
  const out = { tools: [] as string[], apps: [] as string[] };
  for (const e of entries) {
    const m = /^tools\/([^/]+)\/(.+)$/.exec(e.id);
    if (e.rung !== "tools" || m?.[1] === undefined || m[2] === undefined) continue;
    (APP_IDS.includes(m[1]) ? out.apps : out.tools).push(m[2]);
  }
  return out;
}

/** The directory the screen groups a HOME path under: `.hermes`, `.config/gh`, `.local/share/nvim`, `Library/Application Support/Code`. */
export function appDir(path: string): string {
  const segs = path.replace(/^~\//, "").split("/");
  const depth = segs[0] === ".config" ? 2 : segs[0] === ".local" || segs[0] === "Library" ? 3 : 1;
  return segs.slice(0, depth).join("/");
}

/** The places the screen groups rows under, in screen order; a row is grouped under the longest one holding it. */
const LOCATIONS = ["~/.config", "~/.local/share", "~/.local", "~/Library/Application Support", "~/Library/Preferences", "~/Library"];

export function locationOf(path: string): string | undefined {
  return LOCATIONS.filter(l => path.startsWith(`${l}/`)).sort((a, b) => b.length - a.length)[0];
}

const MANAGER_WORDS: Record<Manager, string> = {
  chezmoi: "a chezmoi source state",
  yadm: "yadm's directory",
  stow: "a stow directory",
  dotfiles: "a dotfiles directory",
};

/** The first words of a row's detail: what the passes made of it. App data that matched no app and is no bundle id is so by its place alone, and the words claim no more. */
function whatItIs(r: Row): string {
  if (r.manager !== undefined) return `${MANAGER_WORDS[r.manager]}${(r.rcCopies?.length ?? 0) > 0 ? " holding rc copies" : ""}`;
  if (r.kind === "app-data" && r.tool !== undefined) return `data of the macOS app ${r.tool}; ${APP_DATA_WHY}`;
  const primary = r.paths[0];
  const location = primary === undefined ? undefined : locationOf(primary);
  if (primary === undefined || location === undefined) return ROLE_WORDS[r.kind];
  const entry = primary.slice(location.length + 1).split("/")[0] ?? "";
  if (r.kind === "app-data" && !isBundleId(entry)) return `in ${location}; no installed tool has its name; macOS apps keep their data here`;
  if (r.kind === "unknown") return `in ${location}; no installed tool has its name`;
  return ROLE_WORDS[r.kind];
}

function detailOf(r: Row): string {
  const words = [whatItIs(r)];
  if (r.rcSecrets !== undefined && r.rcSecrets.length > 0) words.push(`secret-shaped exports in ${r.rcSecrets.join(", ")} are cut from the copy`);
  if (r.flags.includes("history")) words.push("a git history: every version ever committed travels with it, secrets included");
  if (r.flags.includes("exports")) words.push("secret-shaped exports under a name the copy does not strip");
  if (r.flags.includes("credential") && r.kind !== "credential") words.push("holds credential-shaped files");
  if (r.tool !== undefined && r.kind !== "app-data") words.push(r.kind === "credential" ? `used by ${r.tool}` : `config for ${r.tool}`);
  // A credential split out of a directory carries that directory's owner guess; nobody installed the key.
  if (r.owner !== undefined && r.kind !== "credential") words.push(r.owner === "app" ? "installed as a macOS app" : `installed by ${r.owner}`);
  if (r.binary !== undefined) words.push(`its program ${r.binary} was installed by hand`);
  if (r.linkTarget !== undefined) words.push(`a link to ${r.linkTarget}`);
  if (r.measured === "lower-bound") words.push("size is a lower bound");
  if (r.measured === "none") words.push("not measured");
  if (r.flags.includes("large")) words.push("large; never copied without a tick");
  if (r.flags.includes("stale")) words.push("its program is gone and nothing changed in two years");
  if (r.flags.includes("partial")) words.push("the credential check stopped early; look inside first");
  return words.join("; ");
}

/** A credential-shaped file is answered per item. A directory that holds one has that file split out as
 * its own row and excluded here, so it is a plain tick unless the credential check stopped early. */
function needsConsent(r: Row): boolean {
  return r.flags.includes("credential") && (r.kind === "credential" || r.flags.includes("partial"));
}

function entryOf(r: Row, label: string): ManifestEntry {
  const nothingToCopy = r.paths.length === 0;
  return {
    rung: "everything",
    id: `everything/${r.id}`,
    label,
    paths: [...r.paths],
    ...(r.excludes.length > 0 ? { excludes: [...r.excludes] } : {}),
    bytes: r.bytes,
    default: "skip",
    ...(nothingToCopy ? { reason: r.kind === "device-bound-login" ? KEYCHAIN_REASON : BY_HAND_REASON } : { detail: detailOf(r) }),
    ...(needsConsent(r) ? { consent: true } : {}),
    role: r.kind,
    ...(r.manager !== undefined ? { manager: r.manager } : {}),
    files: r.files,
    mtime: r.mtime,
  };
}

const RANK = new Map<string, number>([...LOCATIONS.map((l, i): [string, number] => [l, i + 1]), [APP_DATA_GROUP, LOCATIONS.length + 1], [LARGE_GROUP, LOCATIONS.length + 2], [KEYCHAIN_GROUP, LOCATIONS.length + 3], [BY_HAND_GROUP, LOCATIONS.length + 4]]);

/** One manifest row per found row, in screen order: HOME rows by name, an app directory with two or more
 * rows as a group among them, then each config location, then app data, the large group, then what never copies. */
export function entriesFor(rows: readonly Row[]): ManifestEntry[] {
  const inHome = (r: Row): string | undefined => (r.paths[0] === undefined || r.kind === "app-data" || r.flags.includes("large") || locationOf(r.paths[0]) !== undefined ? undefined : appDir(r.paths[0]));
  const perDir = new Map<string, number>();
  for (const r of rows) {
    const dir = inHome(r);
    if (dir !== undefined) perDir.set(dir, (perDir.get(dir) ?? 0) + 1);
  }
  const groupOf = (r: Row): string | undefined => {
    const primary = r.paths[0];
    if (primary === undefined) return r.kind === "device-bound-login" ? KEYCHAIN_GROUP : BY_HAND_GROUP;
    if (r.kind === "app-data") return APP_DATA_GROUP;
    if (r.flags.includes("large")) return LARGE_GROUP;
    const location = locationOf(primary);
    if (location !== undefined) return location;
    const dir = appDir(primary);
    return (perDir.get(dir) ?? 0) > 1 ? dir : undefined;
  };
  // Out of its location group a path-named row shows its parent: the whole path from HOME in the large group, the path from ~/Library in the app data group.
  const labelOf = (r: Row, group: string | undefined): string => {
    const primary = r.paths[0];
    if (primary === undefined || !primary.endsWith(`/${r.name}`)) return r.name;
    if (group === LARGE_GROUP) return primary.slice(2);
    if (group === APP_DATA_GROUP && primary.startsWith("~/Library/")) return primary.slice("~/Library/".length);
    return r.name;
  };
  const drafts = rows.map((r, i) => {
    const group = groupOf(r);
    const label = labelOf(r, group);
    return { i, label, entry: { ...entryOf(r, label), ...(group !== undefined ? { group } : {}) }, rank: RANK.get(group ?? "") ?? 0, key: group ?? r.name };
  });
  const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
  drafts.sort((a, b) => a.rank - b.rank || byName(a.key, b.key) || byName(a.label, b.label) || a.i - b.i);
  return drafts.map(d => d.entry);
}
