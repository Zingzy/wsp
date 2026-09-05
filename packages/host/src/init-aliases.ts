// SPDX-License-Identifier: AGPL-3.0-only
// The shell's aliases against the tools ticks: which point at a tool that is
// not coming, said on the shell row's detail pane in the tools screen's own
// words, and the guard file the pack ships so the machine drops each such
// alias when its command is missing instead of shadowing a command with
// nothing.
import type { ManifestEntry, ShellAlias } from "@wsp/collect";
import { type BrewTable, toolSize } from "@wsp/engine";
import { fmtBytes } from "./init-layout.js";
import { HEAVY_BYTES } from "./init-weight.js";

export type AliasFate = { fate: "coming" } | { fate: "missing"; why: string } | { fate: "unknown" };

/** Where the alias's tool stands: ticked, unticked with the reason the tools screen gives, or nothing here installs it. */
export function aliasFate(a: ShellAlias, entries: readonly ManifestEntry[], ticks: ReadonlySet<string>, brew: BrewTable): AliasFate {
  const row = a.tool === undefined ? undefined : entries.find(e => e.id === a.tool);
  if (row === undefined) return { fate: "unknown" };
  if (ticks.has(row.id)) return { fate: "coming" };
  if (row.reason !== undefined) return { fate: "missing", why: row.reason };
  if (row.linux === "unknown") return { fate: "missing", why: "Linux build unknown, tick to try" };
  const size = toolSize(row, brew);
  if (size !== undefined && size.bytes >= HEAVY_BYTES) return { fate: "missing", why: `skipped: ${fmtBytes(size.bytes)}, tick to bring` };
  return { fate: "missing", why: "unticked, tick to bring" };
}

interface Group {
  runs: string;
  fate: Exclude<AliasFate, { fate: "coming" }>;
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

/** The detail pane's lines under a shell row: one per command its aliases point at that is not coming, capped. */
export function aliasLines(row: ManifestEntry, entries: readonly ManifestEntry[], ticks: ReadonlySet<string>, brew: BrewTable, max: number): string[] {
  const all = groups(row, entries, ticks, brew);
  const shown = all.length > max ? all.slice(0, max - 1) : all;
  const lines = shown.map(g => {
    const tail = g.fate.fate === "missing" ? `which is not coming (${g.fate.why})` : `which nothing here installs (kept on the machine only if it has ${g.runs})`;
    return `${subject(g.members)} ${verb(g.members.length)} at ${g.runs}, ${tail}`;
  });
  if (all.length > max) lines.push(`${all.length - shown.length} more: ${all.slice(shown.length).map(g => g.runs).join(", ")}`);
  return lines;
}

/** Where the guard lands under the guest's home, and the line the rc file gets to read it after everything else. */
export const GUARD_PATH = ".config/wsp/aliases.sh";
export const GUARD_SOURCE_LINE = `[ -r "$HOME/${GUARD_PATH}" ] && . "$HOME/${GUARD_PATH}"`;
export const GUARD_SOURCE_COMMENT = "# wsp: aliases whose command this machine lacks are dropped here, so the plain command runs";

export interface AliasGuard {
  text: string;
  /** The rc file under the guest's home that sources the guard, the row's own. */
  rc: string;
}

/** The guard file for the ticked rows: each alias whose tool is not coming, undone on the machine when its command
 * is missing, one `command -v` per command; a function is listed on the screen but never undone here. */
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
    const drops = [...(plain.length > 0 ? [`unalias ${plain.join(" ")} 2>/dev/null`] : []), ...(suffix.length > 0 ? [`[ -n "\${ZSH_VERSION-}" ] && unalias -s ${suffix.join(" ")} 2>/dev/null`] : [])];
    lines.push(`command -v ${g.runs} >/dev/null 2>&1 || ${drops.length === 1 && plain.length > 0 ? drops[0] : `{ ${drops.join("; ")}; }`}`);
  }
  if (lines.length === 0) return undefined;
  const head = [
    "# wsp writes this file from the recipe; the next import overwrites it.",
    "# Each alias below points at a command this machine may not have. When the command is missing the alias is",
    `# removed, so the plain command runs instead of nothing. ~/${rc.slice(2)} reads this file last.`,
  ];
  return { text: `${[...head, ...lines].join("\n")}\n`, rc: rc.slice(2) };
}
