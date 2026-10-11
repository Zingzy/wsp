// SPDX-License-Identifier: AGPL-3.0-only
// The browser surface's tabs: which port and path, or which web page, each one
// shows and where it has been. The right panel store owns the tab strip
// (browser:<tabId> surfaces); this owns what is behind each id. A cross-origin
// frame tells us nothing about its own navigation, so a framed tab's history
// is the addresses typed; a desktop guest reports each page it goes to, which
// the tab follows in place while the guest keeps the history itself.
import { create } from "zustand";
import type { KnownPort } from "../adapt/ports.js";
import type { PreviewTabSnapshot } from "../components/RightPanelTabs.js";
import { isSite, portAndPath, placeUrl, type Place } from "./url.js";

export interface BrowserTabState {
  readonly id: string;
  /** Places in visit order; null is the servers list. */
  readonly entries: ReadonlyArray<Place | null>;
  readonly index: number;
  /** Counts the places typed or picked, which a guest loads; the guest's own moves leave it. */
  readonly loads: number;
  /** The guest page's own title, "" until it says one. */
  readonly title: string;
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
  createTab: (workspaceId: string, address: Place | null) => string;
  navigate: (workspaceId: string, tabId: string, address: Place | null) => void;
  /** Where the guest went by itself: the current entry becomes it, with no load asked. */
  follow: (workspaceId: string, tabId: string, place: Place) => void;
  titled: (workspaceId: string, tabId: string, title: string) => void;
  back: (workspaceId: string, tabId: string) => void;
  forward: (workspaceId: string, tabId: string) => void;
  reload: (workspaceId: string, tabId: string) => void;
  setZoom: (workspaceId: string, tabId: string, zoom: number) => void;
  /** Drops tabs whose surface is gone. */
  prune: (workspaceId: string, keep: ReadonlyArray<string>) => void;
}

let seq = 0;

const NO_TABS: Record<string, BrowserTabState> = {};

function freshTab(id: string, address: Place | null): BrowserTabState {
  // A tab always starts on the servers list so back has somewhere to go.
  const entries: (Place | null)[] = address === null ? [null] : [null, address];
  return { id, entries, index: entries.length - 1, loads: 0, title: "", reloadNonce: 0, zoom: 1 };
}

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
  createTab: (workspaceId, address) => {
    const id = `t${++seq}`;
    set(state => ({
      byWorkspaceId: {
        ...state.byWorkspaceId,
        [workspaceId]: { ...state.byWorkspaceId[workspaceId], [id]: freshTab(id, address) },
      },
    }));
    return id;
  },
  // A surface id the right panel persisted across a reload has no tab here
  // yet; navigating it brings one into being under the same id.
  navigate: (workspaceId, tabId, address) =>
    set(state => {
      const known = state.byWorkspaceId[workspaceId]?.[tabId];
      if (!known) {
        return { byWorkspaceId: { ...state.byWorkspaceId, [workspaceId]: { ...state.byWorkspaceId[workspaceId], [tabId]: freshTab(tabId, address) } } };
      }
      return {
        byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab => {
          if (samePlace(tab.entries[tab.index] ?? null, address)) return tab;
          const entries = [...tab.entries.slice(0, tab.index + 1), address];
          return { ...tab, entries, index: entries.length - 1, loads: tab.loads + 1 };
        }),
      };
    }),
  follow: (workspaceId, tabId, place) =>
    set(state => ({
      byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab => {
        if (samePlace(tab.entries[tab.index] ?? null, place)) return tab;
        return { ...tab, entries: tab.entries.map((entry, i) => (i === tab.index ? place : entry)) };
      }),
    })),
  titled: (workspaceId, tabId, title) =>
    set(state => ({
      byWorkspaceId: updateTab(state.byWorkspaceId, workspaceId, tabId, tab => (tab.title === title ? tab : { ...tab, title })),
    })),
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

export function currentPlace(tab: BrowserTabState | null): Place | null {
  return tab?.entries[tab.index] ?? null;
}

function samePlace(a: Place | null, b: Place | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (isSite(a) || isSite(b)) return isSite(a) && isSite(b) && a.url === b.url;
  return a.port === b.port && a.path === b.path;
}

/** What each tab's strip entry shows: the process behind the port when the directory knows it, and the path. */
export function previewTabSnapshots(
  tabs: Record<string, BrowserTabState>,
  ports: ReadonlyArray<KnownPort>,
): Record<string, PreviewTabSnapshot> {
  return Object.fromEntries(
    Object.values(tabs).map(tab => {
      const at = currentPlace(tab);
      if (at === null) return [tab.id, { tabId: tab.id, url: null, title: "" }];
      if (isSite(at)) return [tab.id, { tabId: tab.id, url: at.url, title: tab.title || hostOf(at.url) }];
      const process = ports.find(p => p.port === at.port)?.process;
      const where = portAndPath(at.port, at.path);
      return [tab.id, { tabId: tab.id, url: placeUrl(at), title: process ? `${process} ${where}` : where }];
    }),
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
