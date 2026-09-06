// SPDX-License-Identifier: AGPL-3.0-only
// Also on this Mac: the tools a package manager here could install on the
// image, grouped by manager, every row off until it is ticked. A tick writes a
// row the catalog does not carry into the recipe; unticking takes it away
// again, so the screen and the recipe say the same thing on a second pass.
import { fmtBytes, customRows, type Recipe, type RecipeCustomRow } from "@wsp/protocol";
import type { SelectItem } from "./init-select.js";
import { sizeTone } from "./init-weight.js";
import { customFromScan, type ScanRow } from "./scan.js";

export const ALSO_TITLE = "Also on this Mac";

/** One row per scanned tool, grouped by its manager, with the line that installs it and its size here. */
export function alsoItems(rows: readonly ScanRow[]): SelectItem[] {
  return rows.map(r => {
    const tone = sizeTone(r.size);
    return {
      id: r.id,
      label: r.name,
      group: r.group,
      hint: r.size === undefined ? "size unknown" : fmtBytes(r.size),
      ...(tone !== undefined ? { tone } : {}),
      detail: [r.install, r.version === undefined ? "installs on the machine after everything in the catalog" : `${r.version} here; installs on the machine after everything in the catalog`],
    };
  });
}

/** The recipe with the screen's ticks on it: every ticked scan row is a row of its own, and a row an earlier pass
 * of this screen added and nobody ticked this time is gone. Rows from anywhere else are left alone. */
export function withScanned(recipe: Recipe, rows: readonly ScanRow[], ticks: ReadonlySet<string>): Recipe {
  const scanned = new Map(rows.map(r => [customFromScan(r).id, r]));
  const kept = customRows(recipe).filter(c => !scanned.has(c.id));
  const added = rows.filter(r => ticks.has(r.id)).map((r): RecipeCustomRow => customFromScan(r));
  return { ...recipe, custom: [...kept, ...added] };
}

/** The scan rows the recipe already carries, by their row id: what the screen starts ticked. */
export function scannedTicks(recipe: Recipe, rows: readonly ScanRow[]): Set<string> {
  const carried = new Set(customRows(recipe).map(c => c.id));
  return new Set(rows.filter(r => carried.has(customFromScan(r).id)).map(r => r.id));
}
