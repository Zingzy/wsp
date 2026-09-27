// SPDX-License-Identifier: AGPL-3.0-only
// What a wsp:// link names, opened: a thread on the workspace its row is on, a
// workspace, a project's home, a Settings group. The desktop hands the page a
// link as the hash of the first page, or over the bridge while the page is up;
// either way the link is its kind and id alone, and opening one only picks
// what the person reads. Nothing a link names is sent, started or changed.
import { linkFromHash, type LinkTarget } from "@wsp/protocol";
import { desktopBridge } from "../lib/desktopShell.js";
import { addNotice } from "../notices/store.js";
import type { useStore } from "../protocol/store.js";
import { isSettingsGroupId } from "../settings/groupIds.js";
import { groupById } from "../settings/groups.js";
import { useSettingsStore } from "../settings/settingsStore.js";

export const LINK_WORDS = {
  gone: (kind: LinkTarget["kind"]): string => `That link names a ${kind === "settings" ? "Settings page" : kind} this wsp does not have.`,
} as const;

/** Opens what the link names, or says in one line that it names nothing here. */
export function openLink(store: typeof useStore, target: LinkTarget): void {
  const s = store.getState();
  const gone = (): void => void addNotice({ kind: "error", text: LINK_WORDS.gone(target.kind) });
  switch (target.kind) {
    case "thread": {
      const workspaceId = Object.keys(s.sessions).find(id => s.sessions[id]!.some(row => row.threadId === target.id));
      if (workspaceId === undefined) return gone();
      return s.select(workspaceId, target.id);
    }
    case "workspace":
      if (!s.workspaces.some(w => w.id === target.id)) return gone();
      return s.select(target.id);
    case "project":
      if (!s.projects.some(p => p.id === target.id)) return gone();
      return s.openProjectHome(target.id);
    case "settings":
      if (!isSettingsGroupId(target.id) || groupById(target.id).empty === true) return gone();
      useSettingsStore.getState().go({ kind: "group", group: target.id });
      return s.openSettings();
  }
}

/** Mounted once: the link the first page's hash carries, and each one the shell hands over, is opened once the rows
 * it is looked up in have landed. A link that waits for them is opened a microtask past the write that landed them,
 * since the refresh that lands them writes its own address right after and would put the workspace back over the
 * thread the link opened. */
export function wireLinks(store: typeof useStore): () => void {
  let offStore: (() => void) | undefined;
  const landed = (): boolean => store.getState().ready && store.getState().projectsRead;
  const open = (target: LinkTarget): void => {
    offStore?.();
    offStore = undefined;
    if (landed()) return openLink(store, target);
    offStore = store.subscribe(() => {
      if (!landed()) return;
      offStore?.();
      offStore = undefined;
      queueMicrotask(() => openLink(store, target));
    });
  };
  const held = typeof window === "undefined" ? undefined : linkFromHash(window.location.hash);
  if (held !== undefined) open(held);
  const offShell = desktopBridge()?.onOpen?.(open);
  return () => {
    offStore?.();
    offShell?.();
  };
}
