// SPDX-License-Identifier: AGPL-3.0-only
// Reading one harness's catalog: its marked defaults, the efforts a model takes,
// every model a start may name, and the picks a thread's own rows carry. The
// start, the composer and the defaults a new thread resolves to all read these,
// so they sit apart from the wire shapes.
import type { HarnessCatalog, HarnessModel, HarnessOption, SessionView } from "./index.js";

/** The option a list marks as its default, if one is: what an unpicked picker shows and an unnamed start runs. */
export function markedDefault<T extends HarnessOption>(options: ReadonlyArray<T>): T | undefined {
  return options.find(o => o.isDefault === true);
}

function narrowed(all: ReadonlyArray<HarnessOption>, subset: ReadonlyArray<string> | undefined): HarnessOption[] {
  return subset === undefined ? [...all] : all.filter(o => subset.includes(o.value));
}

/** The efforts a model takes: its own subset of the catalog's, in the catalog's order, else all of them, with the
 * one this pick runs at when a turn names none marked. The picked model's own default wins where the binary named
 * one, and the catalog's mark stands only for a model that names none, so the mark is the default of this pick and
 * not of the harness. A model that names a default its own list does not carry marks nothing, as a catalog whose
 * binary does. This is the one rule for that: the composer's effort picker and startPicks both read it. */
export function effortsFor(catalog: HarnessCatalog, model: HarnessModel | null): HarnessOption[] {
  const options = narrowed(catalog.efforts, model?.efforts);
  const own = model?.defaultEffort;
  if (own === undefined) return options;
  return options.map(({ isDefault: _harness, ...rest }) => (rest.value === own ? { ...rest, isDefault: true } : rest));
}

/** Every model a start may name: the catalog's current ones, then its legacy ones, then the ones the person hid. */
export function everyModel(catalog: HarnessCatalog): HarnessModel[] {
  return [...catalog.models, ...(catalog.legacyModels ?? []), ...(catalog.hiddenModels ?? [])];
}

/** The model a pick names, as the catalog knows it; a slug the catalog does not list still counts, named by itself. */
export function modelOf(catalog: HarnessCatalog, value: string | undefined): HarnessModel | null {
  if (value === undefined) return null;
  return everyModel(catalog).find(m => m.value === value) ?? { value, label: value };
}

/** None without a model: the window rides the model as a suffix, so there is nothing to offer it on. */
export function contextWindowsFor(catalog: HarnessCatalog, model: HarnessModel | null): HarnessOption[] {
  return model === null ? [] : narrowed(catalog.contextWindows, model.contextWindows);
}

/**
 * A remembered pick read against the list in front of us: the value where that list carries it, nothing where it
 * does not. Every reader of a pick kept for later needs this and there is one rule for all of them, because a pick
 * is remembered per workspace while the lists belong to a harness and no two harnesses share one (claude's access
 * modes and codex's are disjoint sets, as are their models and efforts). A pick the resolved harness does not take
 * is not a request to refuse: it is a pick that does not apply here, so it is dropped and that list's own default
 * runs. startPicks refuses a value a caller NAMED, which is a different thing and stays an error.
 */
export function listedPick(options: ReadonlyArray<HarnessOption>, value: string | undefined): string | undefined {
  return value !== undefined && options.some(o => o.value === value) ? value : undefined;
}

/** The picks a thread's turns ran with, as its rows carry them. */
export type RanPicks = Partial<Record<"model" | "effort" | "contextWindow" | "permissionMode", string>>;

const ONE_M = /\[1m\]$/;

/** The model a start or a row names, with the window it runs at: the CLI announces the model with its own 1M suffix,
 * and a row that names a window of its own says it outright. The two are read together wherever either is read,
 * since on claude's wire the window rides inside the model string. */
export function modelPicks(model: string, contextWindow?: string): RanPicks {
  const window = contextWindow ?? (ONE_M.test(model) ? "1m" : undefined);
  return { model: model.replace(ONE_M, ""), ...(window !== undefined ? { contextWindow: window } : {}) };
}

/** How each pick is read off one turn's row, one entry per pick, so a pick the thread keeps for itself is an entry
 * here rather than a rule of its own; the model and the window it ran at come from the same row, never two. */
const ROW_READERS: ReadonlyArray<(row: SessionView) => RanPicks | null> = [
  row => (row.model === undefined ? null : modelPicks(row.model, row.contextWindow)),
  row => (row.effort === undefined ? null : { effort: row.effort }),
  row => (row.permissionMode === undefined ? null : { permissionMode: row.permissionMode }),
];

/** What a thread has already run with, from the rows of its turns oldest first: for each pick, the last turn that
 * named one. */
export function recordedPicks(rows: ReadonlyArray<SessionView>): RanPicks {
  const picks: RanPicks = {};
  for (const read of ROW_READERS) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const named = read(rows[i]!);
      if (named !== null) {
        Object.assign(picks, named);
        break;
      }
    }
  }
  return picks;
}

/** The model, effort and window a start into a thread that has run goes with: each one the start names, else the
 * thread's own where the list in front of us carries it for the model the start resolves to. A resume that names
 * none runs on the agent's own default and not the thread's (claude went to its settings' model and window,
 * 2026-10-04), and a value the binary has since dropped is left out rather than refused. */
export function keptPicks(catalog: HarnessCatalog | undefined, ran: RanPicks, named: Omit<RanPicks, "permissionMode">): Omit<RanPicks, "permissionMode"> {
  const picked = (model: string | undefined, effort: string | undefined, contextWindow: string | undefined): Omit<RanPicks, "permissionMode"> => ({
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  });
  if (catalog === undefined) return picked(named.model ?? ran.model, named.effort ?? ran.effort, named.contextWindow ?? ran.contextWindow);
  // The thread's model only where it takes the effort and the window the start names beside it, which win over it.
  const takes = (model: HarnessModel | null): boolean =>
    (named.effort === undefined || catalog.efforts.length === 0 || listedPick(effortsFor(catalog, model), named.effort) !== undefined) &&
    (named.contextWindow === undefined || listedPick(contextWindowsFor(catalog, model), named.contextWindow) !== undefined);
  const own = modelOf(catalog, listedPick(everyModel(catalog), ran.model));
  const chosen = named.model !== undefined ? modelOf(catalog, named.model) : own !== null && takes(own) ? own : null;
  return picked(chosen?.value, named.effort ?? listedPick(effortsFor(catalog, chosen), ran.effort), named.contextWindow ?? listedPick(contextWindowsFor(catalog, chosen), ran.contextWindow));
}
