// SPDX-License-Identifier: AGPL-3.0-only
// The last harness, model, effort and context window picked per workspace,
// kept in local storage so the next thread in that workspace starts the same
// way. A key absent means nothing was picked and the CLI's own default runs.
// Values are the harness's slugs; the runtime passes them through unchanged.
// The access pick is the one that is not here: the host reads it too, to open
// a thread nobody named an access for, so it lives on the preferences record
// and useComposerOptions folds it in beside these.
import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useStore } from "../../protocol/store";

/** The picks this browser keeps. */
export type ComposerOptionKey = "harness" | "model" | "effort" | "contextWindow";

/** Every pick the composer's pickers read: the four above and the access, which is the host's record's. */
export type ComposerOptions = Partial<Record<ComposerOptionKey | "permissionMode", string>>;

const STORAGE_KEY = "wsp:composer-options:v1";
const KEYS: readonly ComposerOptionKey[] = ["harness", "model", "effort", "contextWindow"];
const NONE: ComposerOptions = {};
const NO_THREADS: PickThreads = {};

/** The picks a thread that has run takes only from its own picker: the model, and the window that rides inside it on
 * the wire. Each names its own thread, never one stamp for the pair, or a window picked here would carry a model
 * picked on another thread onto this one. Effort and access are not scoped yet, which is #643; that is one more
 * entry here and in the pickers that write them. */
export const THREAD_SCOPED_PICKS: readonly ComposerOptionKey[] = ["model", "contextWindow"];

/** The thread each of a workspace's scoped picks was made in, by the pick's own key. */
export type PickThreads = Partial<Record<ComposerOptionKey, string>>;

interface ComposerOptionsState {
  byWorkspaceId: Record<string, ComposerOptions>;
  /** Where each scoped pick was made, since every thread of a workspace reads the one record above and without this a
   * model picked in one of them paints the rest; composerPicks reads it to decide which thread a pick belongs to. One
   * slot per pick per workspace is the whole of it: pick on thread A, leave without sending, pick the same key on
   * thread B, and A's button is back on its own model, which is where a thread that ran belongs anyway. */
  pickedOn: Record<string, PickThreads>;
  pick: (workspaceId: string, key: ComposerOptionKey, value: string, thread?: string) => void;
}

function normalizeThreads(persisted: unknown): Record<string, PickThreads> {
  const raw = persisted && typeof persisted === "object" ? (persisted as { pickedOn?: unknown }).pickedOn : undefined;
  if (!raw || typeof raw !== "object") return {};
  const pickedOn: Record<string, PickThreads> = {};
  for (const [workspaceId, threads] of Object.entries(raw as Record<string, unknown>)) {
    if (!threads || typeof threads !== "object") continue;
    const clean: PickThreads = {};
    for (const key of THREAD_SCOPED_PICKS) {
      const value = (threads as Record<string, unknown>)[key];
      if (typeof value === "string" && value !== "") clean[key] = value;
    }
    if (Object.keys(clean).length > 0) pickedOn[workspaceId] = clean;
  }
  return pickedOn;
}

function normalizePersisted(persisted: unknown): { byWorkspaceId: Record<string, ComposerOptions>; pickedOn: Record<string, PickThreads> } {
  const pickedOn = normalizeThreads(persisted);
  const raw = persisted && typeof persisted === "object" ? (persisted as { byWorkspaceId?: unknown }).byWorkspaceId : undefined;
  if (!raw || typeof raw !== "object") return { byWorkspaceId: {}, pickedOn };
  const byWorkspaceId: Record<string, ComposerOptions> = {};
  for (const [workspaceId, options] of Object.entries(raw as Record<string, unknown>)) {
    if (!options || typeof options !== "object") continue;
    const clean: ComposerOptions = {};
    for (const key of KEYS) {
      const value = (options as Record<string, unknown>)[key];
      if (typeof value === "string" && value !== "") clean[key] = value;
    }
    if (Object.keys(clean).length > 0) byWorkspaceId[workspaceId] = clean;
  }
  return { byWorkspaceId, pickedOn };
}

export const useComposerOptionsStore = create<ComposerOptionsState>()(
  persist(
    set => ({
      byWorkspaceId: {},
      pickedOn: {},
      pick: (workspaceId, key, value, thread) =>
        set(s => {
          const current = s.byWorkspaceId[workspaceId] ?? NONE;
          const moved = current[key] !== value;
          // This pick names the thread it was made in, and only this pick: the same value picked again on another
          // thread still moves it there, and no other key's thread moves with it.
          const threads = s.pickedOn[workspaceId] ?? NO_THREADS;
          const marks =
            THREAD_SCOPED_PICKS.includes(key) && thread !== undefined && threads[key] !== thread
              ? { pickedOn: { ...s.pickedOn, [workspaceId]: { ...threads, [key]: thread } } }
              : undefined;
          if (!moved && marks === undefined) return s;
          return { ...(moved ? { byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...current, [key]: value } } } : {}), ...marks };
        }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: s => ({ byWorkspaceId: s.byWorkspaceId, pickedOn: s.pickedOn }),
      migrate: normalizePersisted,
      // migrate runs only on a version change; a bad shape stored at this version must be caught on every hydrate.
      merge: (persisted, current) => ({ ...current, ...normalizePersisted(persisted) }),
    },
  ),
);

/** Everything the composer's pickers show as picked for a workspace: what this browser kept, and the access the
 * host's record holds for it. */
export function useComposerOptions(workspaceId: string): ComposerOptions {
  const picked = useComposerOptionsStore(s => s.byWorkspaceId[workspaceId] ?? NONE);
  const permissionMode = useStore(s => s.preferences.access[workspaceId]);
  return useMemo(() => (permissionMode === undefined ? picked : { ...picked, permissionMode }), [picked, permissionMode]);
}
