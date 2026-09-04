// SPDX-License-Identifier: AGPL-3.0-only
// Sign-in pages a workspace asked to open, one per workspace, until the
// person opens or dismisses them. Nothing opens without a click.
import { isHttpUrl } from "@wsp/protocol";
import { create } from "zustand";

export interface SignInStoreState {
  byWorkspaceId: Record<string, { url: string }>;
  /** Only http(s) is kept: the machine is the untrusted side. */
  announce(workspaceId: string, url: string): void;
  dismiss(workspaceId: string): void;
}

export const useSignInStore = create<SignInStoreState>()(set => ({
  byWorkspaceId: {},
  announce(workspaceId, url) {
    if (!isHttpUrl(url)) return;
    set(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: { url } } }));
  },
  dismiss(workspaceId) {
    set(s => {
      const { [workspaceId]: _gone, ...rest } = s.byWorkspaceId;
      return { byWorkspaceId: rest };
    });
  },
}));
