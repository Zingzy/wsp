// SPDX-License-Identifier: AGPL-3.0-only
// The last model, effort and permission mode picked per workspace, kept in
// local storage so the next thread in that workspace starts the same way. A
// key absent means nothing was picked and the CLI's own default runs. Values
// are the harness's slugs; the runtime passes them through unchanged.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ComposerOptionKey = "model" | "effort" | "permissionMode";

export type ComposerOptions = Partial<Record<ComposerOptionKey, string>>;

const STORAGE_KEY = "wsp:composer-options:v1";
const KEYS: readonly ComposerOptionKey[] = ["model", "effort", "permissionMode"];
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

export function useComposerOptions(workspaceId: string): ComposerOptions {
  return useComposerOptionsStore(s => s.byWorkspaceId[workspaceId] ?? NONE);
}
