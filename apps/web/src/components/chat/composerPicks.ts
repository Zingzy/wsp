// SPDX-License-Identifier: AGPL-3.0-only
// What the composer's pickers stand for and what rides sessions.start, from
// one harness catalog, the picks remembered for the workspace and the values
// the thread already runs on, which are its running turn's, else the ones its
// last start recorded. A pick wins, then the thread's value, then the
// default marked for that pick, which for an effort is the picked model's own
// where its binary names one; a pick the resolved model cannot take shows as
// nothing and is not sent. The model, and the window that rides inside it,
// are the picks a thread that has run takes only from its own picker, each
// read against the thread it was picked on, since the picks are one record
// per workspace and a thread keeps the model it was opened on; effort and
// access do not read those threads yet. Picks ride the
// wire, and with them the model the thread is on, so a send that touched no
// picker keeps that thread where it is: the runtime runs a NEW thread on the
// model and the effort the catalog marks when neither is picked, the same
// ones the pickers show, and an untouched access leaves the CLI's own default
// in place; a context window rides as a suffix on the model, so it brings the
// model along.
import { contextWindowsFor, effortsFor, listedPick, markedDefault, modelOf, type HarnessCatalog, type HarnessModel, type HarnessOption, type SessionView, type StartPicks } from "@wsp/protocol";
import { THREAD_SCOPED_PICKS, type ComposerOptions, type PickThreads } from "./composerOptionsStore";

export interface ResolvedPicks {
  readonly model: string | null;
  readonly effort: string | null;
  readonly contextWindow: string | null;
  readonly permissionMode: string | null;
}

/** What the composer adds to sessions.start beyond the prompt: the checked picks, plus the harness and the context window. */
export type ComposerStart = StartPicks & Partial<Record<"harness" | "contextWindow", string>>;

const ONE_M = /\[1m\]$/;

/** The model the next start runs with, or null when nothing was picked and the catalog marks no default; a picked
 * slug the catalog does not list still counts, named by itself, as it is on a start. */
export function resolveModel(catalog: HarnessCatalog, input: { picked: string | undefined; thread: string | undefined }): HarnessModel | null {
  return modelOf(catalog, input.picked ?? input.thread ?? markedDefault(catalog.models)?.value);
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

/** What the next send inherits from the thread it lands in: a running turn's own values, and between turns the model
 * the thread's last start recorded, read with the same 1M suffix rule. A thread keeps running on the model it was
 * opened with, so that model, and not the catalog's default, is what the pickers show once the turn is over and what
 * the send carries: a default filled in here moves the thread to another model without anyone asking for it. */
export function threadPicks(session: SessionView | null, thread: { running: boolean; model: string | null }): ComposerOptions {
  const live = runningPicks(session, thread.running);
  if (live.model !== undefined || thread.model === null) return live;
  return { model: thread.model.replace(ONE_M, ""), ...(ONE_M.test(thread.model) ? { contextWindow: "1m" } : {}), ...live };
}

/** The picks that apply to the thread in front of the person. The model, and the window that rides inside it on the
 * wire, are kept per workspace while a thread keeps the model it was opened on, so each is dropped here unless it was
 * made on this thread: otherwise it paints this one's button and moves it on the next send. They apply to a thread
 * that has not run, which is what the pick was made for, and each to the thread it was made on, which is someone
 * changing that thread on purpose. Each is read against its own thread and not the pair against one, or picking a
 * window here would carry in a model picked somewhere else. */
export function pickedFor(picked: ComposerOptions, thread: { model: string | null }, pickedOn: PickThreads, threadKey: string): ComposerOptions {
  if (thread.model === null) return picked;
  const applies: ComposerOptions = { ...picked };
  for (const key of THREAD_SCOPED_PICKS) if (pickedOn[key] !== threadKey) delete applies[key];
  return applies;
}

/** What a picker shows: the pick where this list carries it, else the thread's own value, else the list's own
 * default. Each is read against the list rather than the first of them being taken and then checked, so a pick made
 * on another harness leaves the picker showing what the next start will actually run instead of showing nothing. */
function current(options: ReadonlyArray<HarnessOption>, picked: string | undefined, thread: string | undefined): string | null {
  return listedPick(options, picked) ?? listedPick(options, thread) ?? markedDefault(options)?.value ?? null;
}

export function effectivePicks(catalog: HarnessCatalog, input: { picked: ComposerOptions; thread: ComposerOptions }): ResolvedPicks {
  const model = resolveModel(catalog, { picked: input.picked.model, thread: input.thread.model });
  return {
    model: model?.value ?? null,
    effort: current(effortsFor(catalog, model), input.picked.effort, input.thread.effort),
    contextWindow: current(contextWindowsFor(catalog, model), input.picked.contextWindow, input.thread.contextWindow),
    permissionMode: current(catalog.permissionModes, input.picked.permissionMode, input.thread.permissionMode),
  };
}

export function startOptionsFrom(catalog: HarnessCatalog, picked: ComposerOptions, thread: ComposerOptions = {}): ComposerStart {
  const model = resolveModel(catalog, { picked: picked.model, thread: thread.model });
  const effort = listedPick(effortsFor(catalog, model), picked.effort);
  const window = listedPick(contextWindowsFor(catalog, model), picked.contextWindow ?? thread.contextWindow);
  const permissionMode = listedPick(catalog.permissionModes, picked.permissionMode);
  // The thread's own model rides only where this list carries it. Nobody named it on this send, and sessions.start
  // refuses a model the list does not carry, so an inherited one the binary has since dropped would turn every send
  // into a refusal. Unsent, a claude resume keeps the harness session's own model, which is that same model
  // (measured on 2.1.257, 2026-09-12); on a harness whose resume does not, the turn runs on that CLI's own default,
  // which is the price of a send that lands over one that is refused.
  const modelValue = picked.model ?? listedPick(catalog.models, thread.model) ?? (window !== undefined ? listedPick(catalog.models, model?.value) : undefined);
  // A window rides on the model, never alone: claude builds "<model>[1m]" and refuses a window with no model to
  // ride on, so a frame carrying one without the other fails at the adapter.
  const contextWindow = modelValue === undefined ? undefined : window;
  return {
    ...(picked.harness !== undefined ? { harness: picked.harness } : {}),
    ...(modelValue !== undefined ? { model: modelValue } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}
