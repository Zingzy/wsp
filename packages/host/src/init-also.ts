// SPDX-License-Identifier: AGPL-3.0-only
// Also on this Mac: the tools a package manager here could install on the
// image, grouped by manager, every row off until it is ticked. A tick writes a
// row the catalog does not carry into the recipe; unticking takes it away
// again, so the screen and the recipe say the same thing on a second pass.
import { styleText } from "node:util";
import { fmtBytes, customRows, type Recipe, type RecipeCustomRow } from "@wsp/protocol";
import { GUTTER } from "./init-layout.js";
import type { RungAnswer, SelectItem } from "./init-select.js";
import { sizeTone } from "./init-weight.js";
import { customFromScan, type ScanRow } from "./scan.js";

export const ALSO_TITLE = "Also on this Mac";
export const ALSO_TOP = "We found these installed on this Mac. Tick the ones you or your agents need on the image.";
/** What the screen says when no manager here offered a row: it keeps its place in the six either way. */
export const ALSO_EMPTY_TOP = "What this Mac has installed that a package manager could put on the image too.";
export const ALSO_EMPTY = "nothing found here yet";

/** One row per scanned tool, grouped by its manager, with the line that installs it and its size here. A heavy
 * size takes its weight's colour, the one hue on the row. */
export function alsoItems(rows: readonly ScanRow[]): SelectItem[] {
  return rows.map(r => {
    const tone = sizeTone(r.size);
    return {
      id: r.id,
      label: r.name,
      group: r.group,
      hint: { text: r.size === undefined ? "size unknown" : fmtBytes(r.size), ...(tone !== undefined ? { paint: (padded: string) => styleText(tone, padded) } : {}) },
      detail: [r.install, r.version === undefined ? "installs on the machine after everything in the catalog" : `${r.version} here; installs on the machine after everything in the catalog`],
    };
  });
}

/** A manager's header: how many of its rows are ticked and what they weigh here, as the tools screen counts its own. */
export function alsoGroupLine(rows: readonly ScanRow[]): (items: readonly SelectItem[], a: RungAnswer) => string {
  const by = new Map(rows.map(r => [r.id, r]));
  return (items, a) => {
    const on = items.filter(i => a.ticks.has(i.id));
    const bytes = on.reduce((n, i) => n + (by.get(i.id)?.size ?? 0), 0);
    return `${on.length} of ${items.length}${GUTTER}${fmtBytes(bytes)}`;
  };
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
