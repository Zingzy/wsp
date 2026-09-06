// SPDX-License-Identifier: AGPL-3.0-only
// The files a shell rc file sources, against the rows: which of them no row
// that starts ticked carries, and which sit outside home where the machine's
// paths are not this computer's, said on the shell row's detail pane, since
// the pack wraps those lines and the machine skips them. The pack decides from
// what it actually carries; these lines are the hint.
import type { ManifestEntry } from "@wsp/collect";
import type { BrewTable } from "@wsp/engine";
import { capped, rowFate } from "./init-aliases.js";
import { under } from "./init-import.js";

/** The rows whose paths hold the file, excludes honoured. */
function carriers(path: string, rows: readonly ManifestEntry[]): ManifestEntry[] {
  return rows.filter(r => r.paths.some(root => under(path, root)) && !(r.excludes ?? []).some(x => under(path, x)));
}

/** The detail pane's lines under a shell row: one per sourced file no ticked row carries or outside home, capped, the rest named. */
export function sourceLines(row: ManifestEntry, rows: readonly ManifestEntry[], ticks: ReadonlySet<string>, brew: BrewTable, max: number): string[] {
  const said: { path: string; line: string }[] = [];
  for (const path of row.sources ?? []) {
    if (!path.startsWith("~/")) {
      said.push({ path, line: `sources ${path}, a path outside your home; the machine skips that line when it has no such file` });
      continue;
    }
    const by = carriers(path, rows);
    const carrier = by.find(r => ticks.has(r.id)) ?? by[0];
    const fate = rowFate(carrier, ticks, brew);
    if (fate.fate === "coming") continue;
    const why = fate.fate === "missing" && carrier !== undefined ? `which is not coming (${carrier.label} ${fate.why})` : "which nothing here brings";
    said.push({ path, line: `sources ${path}, ${why}; the machine skips that line` });
  }
  return capped(said, max, s => s.line, s => s.path);
}
