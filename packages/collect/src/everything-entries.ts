// SPDX-License-Identifier: AGPL-3.0-only
// The everything rung as manifest rows: what the passes found under HOME
// that no rung claimed, one entry per row, none ticked. The screen groups
// them by app directory, the pack copies paths minus excludes, and a
// credential-shaped row travels only on the person's own answer.
import type { Kind, Row } from "./everything/row.js";
import type { ManifestEntry } from "./manifest.js";

export const LARGE_GROUP = "large, review";
export const KEYCHAIN_GROUP = "Keychain, device-bound";
export const BY_HAND_GROUP = "installed by hand";

const KEYCHAIN_REASON = "signed in here; the login is bound to this device, sign in on the machine";
const BY_HAND_REASON = "installed by hand; reinstall it on the machine";

const ROLE_WORDS: Record<Kind, string> = {
  config: "looks like config",
  state: "state the program rebuilds",
  cache: "cache, rebuilt on use",
  credential: "credential-shaped",
  "device-bound-login": KEYCHAIN_REASON,
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

/** The directory the screen groups a path under: `.hermes`, `.config/gh`, `.local/share/nvim`, `Library/Application Support/Code`. */
export function appDir(path: string): string {
  const segs = path.replace(/^~\//, "").split("/");
  const depth = segs[0] === ".config" ? 2 : segs[0] === ".local" || segs[0] === "Library" ? 3 : 1;
  return segs.slice(0, depth).join("/");
}

function detailOf(r: Row): string {
  const words = [ROLE_WORDS[r.kind]];
  if (r.flags.includes("credential") && r.kind !== "credential") words.push("holds credential-shaped files");
  // A credential split out of a directory carries that directory's owner guess; nobody installed the key.
  if (r.owner !== undefined && r.kind !== "credential") words.push(r.owner === "app" ? "installed as a macOS app" : `installed by ${r.owner}`);
  if (r.binary !== undefined) words.push(`config for ${r.binary.startsWith("~/") ? r.binary : r.binary.slice(r.binary.lastIndexOf("/") + 1)}`);
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

function entryOf(r: Row): ManifestEntry {
  const nothingToCopy = r.paths.length === 0;
  return {
    rung: "everything",
    id: `everything/${r.id}`,
    label: r.name,
    paths: [...r.paths],
    ...(r.excludes.length > 0 ? { excludes: [...r.excludes] } : {}),
    bytes: r.bytes,
    default: "skip",
    ...(nothingToCopy ? { reason: r.kind === "device-bound-login" ? KEYCHAIN_REASON : BY_HAND_REASON } : { detail: detailOf(r) }),
    ...(needsConsent(r) ? { consent: true } : {}),
    role: r.kind,
    files: r.files,
    mtime: r.mtime,
  };
}

const RANK: Record<string, number> = { [LARGE_GROUP]: 1, [KEYCHAIN_GROUP]: 2, [BY_HAND_GROUP]: 3 };

/** One manifest row per found row, in screen order: app directories with two or more rows
 * as groups among the single rows by name, then the large group, then what never copies. */
export function entriesFor(rows: readonly Row[]): ManifestEntry[] {
  const perDir = new Map<string, number>();
  for (const r of rows) {
    if (r.paths.length === 0 || r.flags.includes("large")) continue;
    const dir = appDir(r.paths[0]!);
    perDir.set(dir, (perDir.get(dir) ?? 0) + 1);
  }
  const groupOf = (r: Row): string | undefined => {
    if (r.paths.length === 0) return r.kind === "device-bound-login" ? KEYCHAIN_GROUP : BY_HAND_GROUP;
    if (r.flags.includes("large")) return LARGE_GROUP;
    const dir = appDir(r.paths[0]!);
    return (perDir.get(dir) ?? 0) > 1 ? dir : undefined;
  };
  const drafts = rows.map((r, i) => {
    const group = groupOf(r);
    return { i, name: r.name, entry: { ...entryOf(r), ...(group !== undefined ? { group } : {}) }, rank: RANK[group ?? ""] ?? 0, key: group ?? r.name };
  });
  const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
  drafts.sort((a, b) => a.rank - b.rank || byName(a.key, b.key) || byName(a.name, b.name) || a.i - b.i);
  return drafts.map(d => d.entry);
}
