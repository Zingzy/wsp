// SPDX-License-Identifier: AGPL-3.0-only
// What the composer's pickers stand for and what rides sessions.start, from
// one harness catalog, the picks remembered for the workspace and the values
// of a turn that is running. A pick wins, then the running value, then the
// catalog's default; a pick the resolved model cannot take shows as nothing
// and is not sent. Only picks ride the wire, so an untouched picker leaves
// the CLI's own default in place; a context window is the one exception, it
// rides as a suffix on the model, so it brings the model along.
import type { HarnessCatalog, HarnessModel, HarnessOption, SessionView } from "@wsp/protocol";
import type { ComposerOptions } from "./composerOptionsStore";

export interface ResolvedPicks {
  readonly model: string | null;
  readonly effort: string | null;
  readonly contextWindow: string | null;
  readonly permissionMode: string | null;
}

export type StartPicks = Partial<Record<"harness" | "model" | "effort" | "permissionMode" | "contextWindow", string>>;

const ONE_M = /\[1m\]$/;

/** The model the next start runs with, or null when nothing was picked and the catalog marks no default; a picked
 * slug the catalog does not list still counts, named by itself. */
export function resolveModel(catalog: HarnessCatalog, input: { picked: string | undefined; running: string | undefined }): HarnessModel | null {
  const value = input.picked ?? input.running ?? catalog.models.find(o => o.isDefault)?.value;
  if (value === undefined) return null;
  return catalog.models.find(o => o.value === value) ?? { value, label: value };
}

function narrowed(all: ReadonlyArray<HarnessOption>, subset: ReadonlyArray<string> | undefined): HarnessOption[] {
  return subset === undefined ? [...all] : all.filter(o => subset.includes(o.value));
}

export function effortsFor(catalog: HarnessCatalog, model: HarnessModel | null): HarnessOption[] {
  return narrowed(catalog.efforts, model?.efforts);
}

/** None without a model: the window rides the model as a suffix, so there is nothing to offer it on. */
export function contextWindowsFor(catalog: HarnessCatalog, model: HarnessModel | null): HarnessOption[] {
  return model === null ? [] : narrowed(catalog.contextWindows, model.contextWindows);
}

/** The running session's values, from the runtime's row for it; the CLI announces the model with its own 1M suffix. */
export function runningPicks(session: SessionView | null, running: boolean): ComposerOptions {
  if (!running || session === null || session.status !== "running") return {};
  const contextWindow = session.contextWindow ?? (session.model !== undefined && ONE_M.test(session.model) ? "1m" : undefined);
  return {
    ...(session.model !== undefined ? { model: session.model.replace(ONE_M, "") } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(session.effort !== undefined ? { effort: session.effort } : {}),
    ...(session.permissionMode !== undefined ? { permissionMode: session.permissionMode } : {}),
  };
}

function current(options: ReadonlyArray<HarnessOption>, picked: string | undefined, running: string | undefined): string | null {
  const value = picked ?? running ?? options.find(o => o.isDefault)?.value ?? null;
  return value !== null && options.some(o => o.value === value) ? value : null;
}

export function effectivePicks(catalog: HarnessCatalog, input: { picked: ComposerOptions; running: ComposerOptions }): ResolvedPicks {
  const model = resolveModel(catalog, { picked: input.picked.model, running: input.running.model });
  return {
    model: model?.value ?? null,
    effort: current(effortsFor(catalog, model), input.picked.effort, input.running.effort),
    contextWindow: current(contextWindowsFor(catalog, model), input.picked.contextWindow, input.running.contextWindow),
    permissionMode: current(catalog.permissionModes, input.picked.permissionMode, input.running.permissionMode),
  };
}

export function startOptionsFrom(catalog: HarnessCatalog, picked: ComposerOptions): StartPicks {
  const model = resolveModel(catalog, { picked: picked.model, running: undefined });
  const effort = picked.effort !== undefined && effortsFor(catalog, model).some(o => o.value === picked.effort) ? picked.effort : undefined;
  const contextWindow =
    picked.contextWindow !== undefined && contextWindowsFor(catalog, model).some(o => o.value === picked.contextWindow) ? picked.contextWindow : undefined;
  const permissionMode = picked.permissionMode !== undefined && catalog.permissionModes.some(o => o.value === picked.permissionMode) ? picked.permissionMode : undefined;
  const modelValue = picked.model ?? (contextWindow !== undefined ? model?.value : undefined);
  return {
    ...(picked.harness !== undefined ? { harness: picked.harness } : {}),
    ...(modelValue !== undefined ? { model: modelValue } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}
