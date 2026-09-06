// SPDX-License-Identifier: AGPL-3.0-only
// The files a shell rc file sources, against the rows: which of them no row
// that starts ticked carries, and which sit outside home where the machine's
// paths are not this computer's, said on the shell row's detail pane, since
// the pack wraps those lines and the machine skips them. The pack decides from
// what it actually carries; these lines are the hint.
import type { ManifestEntry } from "@wsp/collect";

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** The rows whose paths hold the file, excludes honoured. */
function carriers(path: string, rows: readonly ManifestEntry[]): ManifestEntry[] {
  return rows.filter(r => r.paths.some(root => under(path, root)) && !(r.excludes ?? []).some(x => under(path, x)));
}

/** The detail pane's lines under a shell row: one per sourced file no coming row carries or outside home, capped, the rest named. */
export function sourceLines(row: ManifestEntry, rows: readonly ManifestEntry[], coming: ReadonlySet<string>, max: number): string[] {
  const said: { path: string; line: string }[] = [];
  for (const path of row.sources ?? []) {
    if (!path.startsWith("~/")) {
      said.push({ path, line: `sources ${path}, a path outside your home; the machine skips that line when it has no such file` });
      continue;
    }
    const by = carriers(path, rows);
    if (by.some(r => coming.has(r.id))) continue;
    const why = by[0] === undefined ? "which nothing here brings" : `which is not coming (${by[0].label} unticked, tick to bring)`;
    said.push({ path, line: `sources ${path}, ${why}; the machine skips that line` });
  }
  if (said.length <= max) return said.map(s => s.line);
  const shown = said.slice(0, max - 1);
  return [...shown.map(s => s.line), `${said.length - shown.length} more: ${said.slice(shown.length).map(s => s.path).join(", ")}`];
}
