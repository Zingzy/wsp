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

interface ComposerOptionsState {
  byWorkspaceId: Record<string, ComposerOptions>;
  pick: (workspaceId: string, key: ComposerOptionKey, value: string) => void;
}

function normalizePersisted(persisted: unknown): { byWorkspaceId: Record<string, ComposerOptions> } {
  const raw = persisted && typeof persisted === "object" ? (persisted as { byWorkspaceId?: unknown }).byWorkspaceId : undefined;
  if (!raw || typeof raw !== "object") return { byWorkspaceId: {} };
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
  return { byWorkspaceId };
}

export const useComposerOptionsStore = create<ComposerOptionsState>()(
  persist(
    set => ({
      byWorkspaceId: {},
      pick: (workspaceId, key, value) =>
        set(s => {
          const current = s.byWorkspaceId[workspaceId] ?? NONE;
          if (current[key] === value) return s;
          return { byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { ...current, [key]: value } } };
        }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: s => ({ byWorkspaceId: s.byWorkspaceId }),
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
