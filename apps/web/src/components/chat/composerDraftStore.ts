// SPDX-License-Identifier: AGPL-3.0-only
// One draft per workspace, kept outside the composer so a glance at another
// tab does not lose what was typed. The prompt editor is controlled from here.
import { create } from "zustand";

export interface ComposerDraft {
  readonly prompt: string;
  readonly cursor: number;
}

export const EMPTY_DRAFT: ComposerDraft = { prompt: "", cursor: 0 };

interface DraftState {
  drafts: Record<string, ComposerDraft>;
  setDraft(workspaceId: string, draft: ComposerDraft): void;
}

export const useComposerDraftStore = create<DraftState>(set => ({
  drafts: {},
  setDraft(workspaceId, draft) {
    set(s => {
      const current = s.drafts[workspaceId];
      if (current !== undefined && current.prompt === draft.prompt && current.cursor === draft.cursor) return s;
      return { drafts: { ...s.drafts, [workspaceId]: draft } };
    });
  },
}));

export function useComposerDraft(workspaceId: string): ComposerDraft {
  return useComposerDraftStore(s => s.drafts[workspaceId] ?? EMPTY_DRAFT);
}
