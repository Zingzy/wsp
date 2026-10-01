// SPDX-License-Identifier: AGPL-3.0-only
// Reading one harness's catalog: its marked defaults, the efforts a model takes,
// every model a start may name. The start, the composer and the defaults a new
// thread resolves to all read these, so they sit apart from the wire shapes.
import type { HarnessCatalog, HarnessModel, HarnessOption } from "./index.js";

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
