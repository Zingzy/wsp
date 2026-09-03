// Adapted from pingdotgg/t3code apps/web/src/rightPanelStore.ts at 57a66608 (MIT).
/**
 * Workspace-scoped right-panel surface state.
 *
 * This is intentionally a shallow model: it owns an ordered set of surface
 * descriptors and the active surface, while each feature continues to own
 * its durable resource state. Browser surfaces point at preview tab ids,
 * terminal surfaces point at terminal session ids, file surfaces point at
 * workspace paths, and diff/files/machine/screen remain singleton surfaces.
 *
 * Keyed by workspace id: a wsp workspace is one machine, and every surface
 * here (terminal, browser, machine, screen) belongs to the machine, not to
 * one conversation on it.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const RIGHT_PANEL_KINDS = ["diff", "files", "file", "preview", "terminal", "machine", "screen"] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | {
      id: `terminal:${string}`;
      kind: "terminal";
      resourceId: string;
      terminalIds: string[];
      activeTerminalId: string;
      splitDirection?: "horizontal" | "vertical";
    }
  | { id: "diff"; kind: "diff" }
  | { id: "files"; kind: "files" }
  | {
      id: `file:${string}`;
      kind: "file";
      /** Workspace-relative, or absolute for a host file outside the workspace. */
      relativePath: string;
      revealLine: number | null;
      revealRequestId: number;
    }
  | { id: "machine"; kind: "machine" }
  | { id: "screen"; kind: "screen" };

const RIGHT_PANEL_STORAGE_KEY = "wsp:right-panel-state:v1";
const RIGHT_PANEL_STORAGE_VERSION = 1;
export const RIGHT_PANEL_WIDTH_STORAGE_KEY = "wsp:right-panel-width";

export interface WorkspaceRightPanelState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
}

type SingletonKind = Exclude<RightPanelKind, "file" | "preview" | "terminal">;
type OpenableKind = Exclude<RightPanelKind, "file" | "terminal">;

interface RightPanelStoreState {
  byWorkspaceId: Record<string, WorkspaceRightPanelState>;
  open: (workspaceId: string, kind: OpenableKind) => void;
  openBrowser: (workspaceId: string, tabId: string | null) => void;
  openFile: (workspaceId: string, relativePath: string, line?: number) => void;
  openTerminal: (workspaceId: string, terminalId: string) => void;
  splitTerminal: (
    workspaceId: string,
    surfaceId: string,
    terminalId: string,
    direction?: "horizontal" | "vertical",
  ) => void;
  activateTerminal: (workspaceId: string, surfaceId: string, terminalId: string) => void;
  closeTerminal: (workspaceId: string, surfaceId: string, terminalId: string) => void;
  activateSurface: (workspaceId: string, surfaceId: string) => void;
  closeSurface: (workspaceId: string, surfaceId: string) => void;
  closeOtherSurfaces: (workspaceId: string, surfaceId: string) => void;
  closeSurfacesToRight: (workspaceId: string, surfaceId: string) => void;
  closeAllSurfaces: (workspaceId: string) => void;
  reconcileBrowserSurfaces: (workspaceId: string, tabIds: readonly string[]) => void;
  reconcileTerminalSurfaces: (workspaceId: string, ptyIds: readonly string[]) => void;
  show: (workspaceId: string) => void;
  close: (workspaceId: string) => void;
  toggleVisibility: (workspaceId: string) => void;
  toggle: (workspaceId: string, kind: OpenableKind) => void;
  removeWorkspace: (workspaceId: string) => void;
}

/**
 * A workspace nobody has touched shows an open, empty panel: the surface
 * picker is how the right panel is discovered until a palette exists.
 */
const EMPTY_WORKSPACE_STATE: WorkspaceRightPanelState = {
  isOpen: true,
  activeSurfaceId: null,
  surfaces: [],
};

const singletonSurface = (kind: SingletonKind): RightPanelSurface => {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "files":
      return { id: "files", kind };
    case "machine":
      return { id: "machine", kind };
    case "screen":
      return { id: "screen", kind };
  }
};

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const fileSurface = (
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine,
  revealRequestId,
});

const terminalSurface = (terminalId: string): RightPanelSurface => ({
  id: `terminal:${terminalId}`,
  kind: "terminal",
  resourceId: terminalId,
  terminalIds: [terminalId],
  activeTerminalId: terminalId,
});

const upsertSurface = (
  current: WorkspaceRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): WorkspaceRightPanelState => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const isEmptyState = (state: WorkspaceRightPanelState): boolean =>
  state.isOpen === EMPTY_WORKSPACE_STATE.isOpen &&
  state.activeSurfaceId === null &&
  state.surfaces.length === 0;

const updateWorkspace = (
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string,
  updater: (current: WorkspaceRightPanelState) => WorkspaceRightPanelState,
): Record<string, WorkspaceRightPanelState> => {
  const current = byWorkspaceId[workspaceId] ?? EMPTY_WORKSPACE_STATE;
  const next = updater(current);
  if (isEmptyState(next)) {
    if (!(workspaceId in byWorkspaceId)) return byWorkspaceId;
    const { [workspaceId]: _removed, ...rest } = byWorkspaceId;
    return rest;
  }
  if (next === current) return byWorkspaceId;
  return { ...byWorkspaceId, [workspaceId]: next };
};

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

const isKnownKind = (kind: unknown): kind is RightPanelKind =>
  typeof kind === "string" && (RIGHT_PANEL_KINDS as readonly string[]).includes(kind);

/** Drops anything persisted under a kind this build does not know. */
export function migratePersistedRightPanelState(persistedState: unknown): {
  byWorkspaceId: Record<string, WorkspaceRightPanelState>;
} {
  if (!persistedState || typeof persistedState !== "object") return { byWorkspaceId: {} };
  const raw = (persistedState as { byWorkspaceId?: unknown }).byWorkspaceId;
  if (!raw || typeof raw !== "object") return { byWorkspaceId: {} };
  const byWorkspaceId = Object.fromEntries(
    Object.entries(raw as Record<string, Partial<WorkspaceRightPanelState> | null>).map(
      ([workspaceId, state]) => {
        const surfaces = Array.isArray(state?.surfaces)
          ? (state.surfaces as RightPanelSurface[]).filter((surface) => isKnownKind(surface?.kind))
          : [];
        const activeSurfaceId = surfaces.some((surface) => surface.id === state?.activeSurfaceId)
          ? (state?.activeSurfaceId ?? null)
          : (surfaces[0]?.id ?? null);
        const isOpen = typeof state?.isOpen === "boolean" ? state.isOpen : EMPTY_WORKSPACE_STATE.isOpen;
        return [workspaceId, { isOpen, surfaces, activeSurfaceId }];
      },
    ),
  );
  return { byWorkspaceId };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      byWorkspaceId: {},
      open: (workspaceId, kind) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      openBrowser: (workspaceId, tabId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const surface = browserSurface(tabId);
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((entry) => entry.id !== "browser:new")
              : current.surfaces;
            return upsertSurface({ ...current, surfaces: withoutPlaceholder }, surface);
          }),
        })),
      openFile: (workspaceId, relativePath, line) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            // The explorer stays open beside the file: our file surface has
            // no tree of its own, so closing the Files tab would strand it.
            const surfaceId = `file:${relativePath}` as const;
            const existing = current.surfaces.find(
              (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
                surface.id === surfaceId && surface.kind === "file",
            );
            const surface = fileSurface(
              relativePath,
              normalizeRevealLine(line),
              (existing?.revealRequestId ?? 0) + 1,
            );
            return {
              isOpen: true,
              activeSurfaceId: surface.id,
              surfaces: existing
                ? current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry))
                : [...current.surfaces, surface],
            };
          }),
        })),
      openTerminal: (workspaceId, terminalId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) =>
            upsertSurface(current, terminalSurface(terminalId)),
          ),
        })),
      splitTerminal: (workspaceId, surfaceId, terminalId, direction = "horizontal") =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => ({
            ...current,
            isOpen: true,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) => {
              if (surface.id !== surfaceId || surface.kind !== "terminal") return surface;
              const { splitDirection: _splitDirection, ...baseSurface } = surface;
              return {
                ...baseSurface,
                terminalIds: surface.terminalIds.includes(terminalId)
                  ? surface.terminalIds
                  : [...surface.terminalIds, terminalId],
                activeTerminalId: terminalId,
                ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
              };
            }),
          })),
        })),
      activateTerminal: (workspaceId, surfaceId, terminalId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => ({
            ...current,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId &&
              surface.kind === "terminal" &&
              surface.terminalIds.includes(terminalId)
                ? { ...surface, activeTerminalId: terminalId }
                : surface,
            ),
          })),
        })),
      closeTerminal: (workspaceId, surfaceId, terminalId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === "terminal",
            );
            if (!surface || surface.kind !== "terminal") return current;
            const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
            if (terminalIds.length === 0) {
              const index = current.surfaces.findIndex((entry) => entry.id === surfaceId);
              const surfaces = current.surfaces.filter((entry) => entry.id !== surfaceId);
              const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
              return {
                ...current,
                isOpen: surfaces.length > 0 && current.isOpen,
                surfaces,
                activeSurfaceId:
                  current.activeSurfaceId === surfaceId
                    ? (fallback?.id ?? null)
                    : current.activeSurfaceId,
              };
            }
            return {
              ...current,
              surfaces: current.surfaces.map((entry) =>
                entry.id === surfaceId && entry.kind === "terminal"
                  ? {
                      ...entry,
                      terminalIds,
                      activeTerminalId:
                        entry.activeTerminalId === terminalId
                          ? (terminalIds.at(-1) ?? terminalIds[0]!)
                          : entry.activeTerminalId,
                    }
                  : entry,
              ),
            };
          }),
        })),
      activateSurface: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        })),
      closeSurface: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            if (current.activeSurfaceId !== surfaceId) {
              return { ...current, surfaces };
            }
            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
            return {
              ...current,
              surfaces,
              activeSurfaceId: fallback?.id ?? null,
            };
          }),
        })),
      closeOtherSurfaces: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length === 1) return current;
            return {
              ...current,
              isOpen: true,
              surfaces: [surface],
              activeSurfaceId: surface.id,
            };
          }),
        })),
      closeSurfacesToRight: (workspaceId, surfaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
            };
          }),
        })),
      closeAllSurfaces: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) =>
            current.surfaces.length === 0
              ? current
              : { ...current, surfaces: [], activeSurfaceId: null },
          ),
        })),
      reconcileBrowserSurfaces: (workspaceId, tabIds) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
            const nonBrowser = current.surfaces.filter((surface) => surface.kind !== "preview");
            const existingBrowser = current.surfaces.filter(
              (surface): surface is Extract<RightPanelSurface, { kind: "preview" }> =>
                surface.kind === "preview" &&
                surface.id !== "browser:new" &&
                validIds.has(surface.id),
            );
            const knownIds = new Set(existingBrowser.map((surface) => surface.id));
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`))
              .map((tabId) => browserSurface(tabId));
            const surfaces = [...nonBrowser, ...existingBrowser, ...added];
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
            };
          }),
        })),
      reconcileTerminalSurfaces: (workspaceId, ptyIds) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const live = new Set(ptyIds);
            let changed = false;
            const surfaces: RightPanelSurface[] = [];
            for (const surface of current.surfaces) {
              if (surface.kind !== "terminal") {
                surfaces.push(surface);
                continue;
              }
              const terminalIds = surface.terminalIds.filter((id) => live.has(id));
              if (terminalIds.length === surface.terminalIds.length) {
                surfaces.push(surface);
                continue;
              }
              changed = true;
              if (terminalIds.length === 0) continue;
              surfaces.push({
                ...surface,
                terminalIds,
                activeTerminalId: terminalIds.includes(surface.activeTerminalId)
                  ? surface.activeTerminalId
                  : terminalIds.at(-1)!,
              });
            }
            if (!changed) return current;
            const activeStillExists = surfaces.some((surface) => surface.id === current.activeSurfaceId);
            return {
              ...current,
              surfaces,
              activeSurfaceId: activeStillExists ? current.activeSurfaceId : (surfaces[0]?.id ?? null),
            };
          }),
        })),
      show: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        })),
      close: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        })),
      toggleVisibility: (workspaceId) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        })),
      toggle: (workspaceId, kind) =>
        set((state) => ({
          byWorkspaceId: updateWorkspace(state.byWorkspaceId, workspaceId, (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (current.isOpen && active?.kind === kind) {
              return { ...current, isOpen: false };
            }
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      removeWorkspace: (workspaceId) =>
        set((state) => {
          if (!(workspaceId in state.byWorkspaceId)) return state;
          const { [workspaceId]: _removed, ...rest } = state.byWorkspaceId;
          return { byWorkspaceId: rest };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({ byWorkspaceId: state.byWorkspaceId }),
      migrate: migratePersistedRightPanelState,
    },
  ),
);

export function selectWorkspaceRightPanelState(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined,
): WorkspaceRightPanelState {
  if (!workspaceId) return EMPTY_WORKSPACE_STATE;
  return byWorkspaceId[workspaceId] ?? EMPTY_WORKSPACE_STATE;
}

export function selectActiveRightPanel(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined,
): RightPanelKind | null {
  const state = selectWorkspaceRightPanelState(byWorkspaceId, workspaceId);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveRightPanelSurface(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined,
): RightPanelSurface | null {
  const state = selectWorkspaceRightPanelState(byWorkspaceId, workspaceId);
  if (!state.isOpen) return null;
  return selectSelectedRightPanelSurface(byWorkspaceId, workspaceId);
}

/** The selected surface even while the panel is hidden, so a layout control can restore it. */
export function selectSelectedRightPanelSurface(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined,
): RightPanelSurface | null {
  const state = selectWorkspaceRightPanelState(byWorkspaceId, workspaceId);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

/** Every pty the workspace's right-panel terminal surfaces hold; the drawer arranges the rest. */
export function selectPanelTerminalIds(
  byWorkspaceId: Record<string, WorkspaceRightPanelState>,
  workspaceId: string | null | undefined,
): string[] {
  const state = selectWorkspaceRightPanelState(byWorkspaceId, workspaceId);
  return state.surfaces.flatMap((surface) => (surface.kind === "terminal" ? surface.terminalIds : []));
}
