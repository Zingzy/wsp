// SPDX-License-Identifier: AGPL-3.0-only
// The shell's aliases against the tools ticks: which point at a tool that is
// not coming, said on the shell row's detail pane in the tools screen's own
// words, and the guard file the pack ships so the machine drops each such
// alias when its command is missing instead of shadowing a command with
// nothing.
import { type ManifestEntry, type ShellAlias, guardLine } from "@wsp/collect";
import { type BrewTable, toolSize } from "@wsp/engine";
import { fmtBytes } from "./init-layout.js";
import { HEAVY_BYTES } from "./init-weight.js";

export type RowFate = { fate: "coming" } | { fate: "missing"; why: string } | { fate: "unknown" };

/** Where a row stands: ticked, unticked with the reason its own screen gives, or no row at all. */
export function rowFate(row: ManifestEntry | undefined, ticks: ReadonlySet<string>, brew: BrewTable): RowFate {
  if (row === undefined) return { fate: "unknown" };
  if (ticks.has(row.id)) return { fate: "coming" };
  if (row.reason !== undefined) return { fate: "missing", why: row.reason };
  if (row.linux === "unknown") return { fate: "missing", why: "Linux build unknown, tick to try" };
  const size = toolSize(row, brew);
  if (size !== undefined && size.bytes >= HEAVY_BYTES) return { fate: "missing", why: `skipped: ${fmtBytes(size.bytes)}, tick to bring` };
  return { fate: "missing", why: "unticked, tick to bring" };
}

/** Where the alias's tool stands; an alias with no tool row is unknown. */
export function aliasFate(a: ShellAlias, entries: readonly ManifestEntry[], ticks: ReadonlySet<string>, brew: BrewTable): RowFate {
  return rowFate(a.tool === undefined ? undefined : entries.find(e => e.id === a.tool), ticks, brew);
}

/** At most `max` lines: all of them when they fit, else the first `max - 1` and one naming the rest. */
export function capped<T>(items: readonly T[], max: number, line: (item: T) => string, name: (item: T) => string): string[] {
  if (items.length <= max) return items.map(line);
  const shown = items.slice(0, max - 1);
  return [...shown.map(line), `${items.length - shown.length} more: ${items.slice(shown.length).map(name).join(", ")}`];
}

interface Group {
  runs: string;
  fate: Exclude<RowFate, { fate: "coming" }>;
  members: ShellAlias[];
}

/** The row's aliases whose tool is not coming, one group per command: not coming before unknown, larger groups first. */
function groups(row: ManifestEntry, entries: readonly ManifestEntry[], ticks: ReadonlySet<string>, brew: BrewTable): Group[] {
  const by = new Map<string, Group>();
  for (const a of row.aliases ?? []) {
    const fate = aliasFate(a, entries, ticks, brew);
    if (fate.fate === "coming") continue;
    const g = by.get(a.runs) ?? { runs: a.runs, fate, members: [] };
    g.members.push(a);
    by.set(a.runs, g);
  }
  const rank = (g: Group): number => (g.fate.fate === "missing" ? 0 : 1);
  return [...by.values()].sort((x, y) => rank(x) - rank(y) || y.members.length - x.members.length || (x.runs < y.runs ? -1 : 1));
}

/** `ls`, `ls and ll`, `ls, ll, la and lt`, `ls, ll, la and 2 more`. */
function named(names: readonly string[]): string {
  if (names.length <= 4) return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

function subject(members: readonly ShellAlias[]): string {
  const aliases = members.filter(m => m.kind !== "function").map(m => m.name);
  const functions = members.filter(m => m.kind === "function").map(m => m.name);
  return [aliases.length > 0 ? `${aliases.length === 1 ? "alias" : "aliases"} ${named(aliases)}` : "", functions.length > 0 ? `${functions.length === 1 ? "function" : "functions"} ${named(functions)}` : ""].filter(s => s !== "").join(" and ");
}

const verb = (n: number): string => (n === 1 ? "points" : "point");

const FROM_FILES_LINE = "aliases read from the rc files: the shell listed none or did not finish in time";

/** The detail pane's lines under a shell row: where the list came from when not the shell, then one per command its
 * aliases point at that is not coming, capped. */
export function aliasLines(row: ManifestEntry, entries: readonly ManifestEntry[], ticks: ReadonlySet<string>, brew: BrewTable, max: number): string[] {
  const line = (g: Group): string => {
    const tail = g.fate.fate === "missing" ? `which is not coming (${g.fate.why})` : `which nothing here installs (kept on the machine only if it has ${g.runs})`;
    return `${subject(g.members)} ${verb(g.members.length)} at ${g.runs}, ${tail}`;
  };
  return [...(row.aliasesFrom === "files" ? [FROM_FILES_LINE] : []), ...capped(groups(row, entries, ticks, brew), max, line, g => g.runs)];
}

/** Where the guard lands under the guest's home, and the line the rc file gets to read it after everything else. */
export const GUARD_PATH = ".config/wsp/aliases.sh";
export const GUARD_SOURCE_LINE = guardLine(`"$HOME/${GUARD_PATH}"`);
export const GUARD_SOURCE_COMMENT = "# wsp: aliases whose command this machine lacks are dropped here, so the plain command runs";

export interface AliasGuard {
  text: string;
  /** The rc file under the guest's home that sources the guard, the row's own. */
  rc: string;
}

/** Single-quoted for the shell: a quoted word is never alias-expanded, which matters for a global alias's name. */
const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** command -v would also answer for an alias or a function, so a self-alias like eza='eza --icons' would hide a missing eza. */
const ON_PATH = 'if [ -n "${ZSH_VERSION-}" ]; then _wsp_on_path() { whence -p -- "$1" >/dev/null 2>&1; }; else _wsp_on_path() { type -P -- "$1" >/dev/null 2>&1; }; fi';

/** The guard file for the ticked rows: each alias whose tool is not coming, undone on the machine when its command
 * is off PATH, one lookup per command; a function is listed on the screen but never undone here. */
export function aliasGuardFor(rows: readonly ManifestEntry[], brew: BrewTable = new Map()): AliasGuard | undefined {
  const ticks = new Set(rows.filter(e => e.bring === true).map(e => e.id));
  const row = rows.find(e => e.bring === true && e.rung === "shell" && (e.aliases?.length ?? 0) > 0);
  const rc = row?.paths[0];
  if (row === undefined || rc === undefined || !rc.startsWith("~/")) return undefined;
  const lines: string[] = [];
  for (const g of groups(row, rows, ticks, brew)) {
    const plain = g.members.filter(m => m.kind === "alias").map(m => m.name);
    const suffix = g.members.filter(m => m.kind === "suffix").map(m => m.name);
    if (plain.length === 0 && suffix.length === 0) continue;
    const names = [...plain, ...suffix];
    const why = g.fate.fate === "missing" ? `not coming (${g.fate.why})` : "nothing here installs it";
    lines.push(`# ${named(names)} ${verb(names.length)} at ${g.runs}: ${why}`);
    const drops = [...(plain.length > 0 ? [`unalias -- ${plain.map(sq).join(" ")} 2>/dev/null`] : []), ...(suffix.length > 0 ? [`[ -n "\${ZSH_VERSION-}" ] && unalias -s -- ${suffix.map(sq).join(" ")} 2>/dev/null`] : [])];
    lines.push(`_wsp_on_path ${sq(g.runs)} || ${drops.length === 1 && plain.length > 0 ? drops[0] : `{ ${drops.join("; ")}; }`}`);
  }
  if (lines.length === 0) return undefined;
  const head = [
    "# wsp writes this file from the recipe; the next import overwrites it.",
    "# Each alias below points at a command this machine may not have. When the command is off PATH the alias is",
    `# removed, so the plain command runs instead of nothing. ~/${rc.slice(2)} reads this file last.`,
    ON_PATH,
  ];
  return { text: `${[...head, ...lines, "unset -f _wsp_on_path"].join("\n")}\n`, rc: rc.slice(2) };
}
