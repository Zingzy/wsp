// SPDX-License-Identifier: AGPL-3.0-only
// The browser surface's tabs: which port each one frames and where it has
// been. The right panel store owns the tab strip (browser:<tabId> surfaces);
// this owns what is behind each id. A cross-origin frame tells us nothing
// about its own navigation, so history is the ports we framed, not pages.
import { create } from "zustand";
import type { KnownPort } from "../adapt/ports.js";
import type { PreviewTabSnapshot } from "../components/RightPanelTabs.js";
import { loopbackUrl } from "./url.js";

export interface BrowserTabState {
  readonly id: string;
  /** Framed ports in visit order; null is the servers list. */
  readonly entries: ReadonlyArray<number | null>;
  readonly index: number;
  /** Keys the frame so a bump remounts it. */
  readonly reloadNonce: number;
  readonly zoom: number;
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

type TabsByWorkspace = Record<string, Record<string, BrowserTabState>>;

interface BrowserTabsStore {
  byWorkspaceId: TabsByWorkspace;
  createTab: (workspaceId: string, port: number | null) => string;
  navigate: (workspaceId: string, tabId: string, port: number | null) => void;
  back: (workspaceId: string, tabId: string) => void;
  forward: (workspaceId: string, tabId: string) => void;
  reload: (workspaceId: string, tabId: string) => void;
  setZoom: (workspaceId: string, tabId: string, zoom: number) => void;
  /** Drops tabs whose surface is gone. */
  prune: (workspaceId: string, keep: ReadonlyArray<string>) => void;
}

let seq = 0;

const NO_TABS: Record<string, BrowserTabState> = {};

function updateTab(
  byWorkspaceId: TabsByWorkspace,
  workspaceId: string,
  tabId: string,
  updater: (tab: BrowserTabState) => BrowserTabState,
): TabsByWorkspace {
  const tab = byWorkspaceId[workspaceId]?.[tabId];
  if (!tab) return byWorkspaceId;
  const next = updater(tab);
  if (next === tab) return byWorkspaceId;
  return { ...byWorkspaceId, [workspaceId]: { ...byWorkspaceId[workspaceId], [tabId]: next } };
}

export const useBrowserTabs = create<BrowserTabsStore>()(set => ({
  byWorkspaceId: {},
  createTab: (workspaceId, port) => {
    const id = `t${++seq}`;
    // A tab always starts on the servers list so back has somewhere to go.
    const entries: (number | null)[] = port === null ? [null] : [null, port];
    set(state => ({
      byWorkspaceId: {
        ...state.byWorkspaceId,
        [workspaceId]: {
          ...state.byWorkspaceId[workspaceId],
          [id]: { id, entries, index: entries.length - 1, reloadNonce: 0, zoom: 1 },
        },
      },
    }));
    return id;
  },
  // A surface id the right panel persisted across a reload has no tab here
  // yet; navigating it brings one into being under the same id.
  navigate: (workspaceId, tabId, port) =>
    set(state => {
      const known = state.byWorkspaceId[workspaceId]?.[tabId];
      if (!known) {
        const entries: (number | null)[] = port === null ? [null] : [null, port];
        return {
          byWorkspaceId: {
            ...state.byWorkspaceId,
            [workspaceId]: {
              ...state.byWorkspaceId[workspaceId],
              [tabId]: { id: tabId, entries, index: entries.length - 1, reloadNonce: 0, zoom: 1 },
            },
          },
        };
      }
      return {
        byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab => {
          if (tab.entries[tab.index] === port) return tab;
          const entries = [...tab.entries.slice(0, tab.index + 1), port];
          return { ...tab, entries, index: entries.length - 1 };
        }),
      };
    }),
  back: (workspaceId, tabId) =>
    set(state => ({
      byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab => (tab.index > 0 ? { ...tab, index: tab.index - 1 } : tab)),
    })),
  forward: (workspaceId, tabId) =>
    set(state => ({
      byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab =>
        tab.index < tab.entries.length - 1 ? { ...tab, index: tab.index + 1 } : tab,
      ),
    })),
  reload: (workspaceId, tabId) =>
    set(state => ({
      byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab => ({ ...tab, reloadNonce: tab.reloadNonce + 1 })),
    })),
  setZoom: (workspaceId, tabId, zoom) =>
    set(state => ({
      byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab => {
        const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
        return clamped === tab.zoom ? tab : { ...tab, zoom: clamped };
      }),
    })),
  prune: (workspaceId, keep) =>
    set(state => {
      const tabs = state.byWorkspaceId[workspaceId];
      if (!tabs) return state;
      const kept = Object.fromEntries(Object.entries(tabs).filter(([id]) => keep.includes(id)));
      if (Object.keys(kept).length === Object.keys(tabs).length) return state;
      const { [workspaceId]: _dropped, ...rest } = state.byWorkspaceId;
      return { byWorkspaceId: Object.keys(kept).length === 0 ? rest : { ...rest, [workspaceId]: kept } };
    }),
}));

/** Test isolation: forget every workspace's tabs. */
export function resetBrowserTabs(): void {
  useBrowserTabs.setState({ byWorkspaceId: {} });
}

export function useBrowserTab(workspaceId: string, tabId: string | null): BrowserTabState | null {
  return useBrowserTabs(s => (tabId === null ? null : (s.byWorkspaceId[workspaceId]?.[tabId] ?? null)));
}

export function useWorkspaceBrowserTabs(workspaceId: string): Record<string, BrowserTabState> {
  return useBrowserTabs(s => s.byWorkspaceId[workspaceId] ?? NO_TABS);
}

export function currentPort(tab: BrowserTabState | null): number | null {
  return tab?.entries[tab.index] ?? null;
}

/** What each tab's strip entry shows: the process behind the port when the directory knows it. */
export function previewTabSnapshots(
  tabs: Record<string, BrowserTabState>,
  ports: ReadonlyArray<KnownPort>,
): Record<string, PreviewTabSnapshot> {
  return Object.fromEntries(
    Object.values(tabs).map(tab => {
      const port = currentPort(tab);
      if (port === null) return [tab.id, { tabId: tab.id, url: null, title: "" }];
      const process = ports.find(p => p.port === port)?.process;
      return [tab.id, { tabId: tab.id, url: loopbackUrl(port), title: process ? `${process} :${port}` : `:${port}` }];
    }),
  );
}
