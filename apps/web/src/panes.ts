// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's pane kinds, one entry each, in the order the launcher and
// the add menu show them. The store, the tab strip, the launcher, its letters
// and this computer's link all read this table; what a pane draws is the one
// line each kind has in RightPanel's view table. This module imports no
// component, since the store reads it and every pane imports the store.
import { Activity, Bot, Cpu, File, FileDiff, Folder, Globe2, TerminalSquare, type LucideIcon } from "lucide-react";
import type { AbsentComputer, WorkspaceView } from "@wsp/protocol";
import type { PreviewTabSnapshot } from "./components/RightPanelTabs";
import { baseName } from "./files/entries";
import type { RightPanelSurface } from "./rightPanelStore";

export type RightPanelKind = "preview" | "terminal" | "diff" | "files" | "machine" | "processes" | "agents";

/** What decides whether a pane can open: the panel's workspace, or this computer's own panel. */
export interface PaneContext {
  here: boolean;
  workspace: WorkspaceView | null;
  absent: AbsentComputer | null;
}

/** What a tab reads its name from, for the kinds whose name is not their label. */
export interface TabNames {
  previewSessions: Readonly<Record<string, PreviewTabSnapshot>>;
  terminalLabelsById: ReadonlyMap<string, string>;
}

export interface Pane<K extends RightPanelKind = RightPanelKind> {
  label: string;
  description: string;
  icon: LucideIcon;
  shortcut: string;
  /** The line a held card and menu item carry when the context names no reason of its own. */
  hint: string;
  available(at: PaneContext): boolean;
  reason?(at: PaneContext): string | undefined;
  title?(surface: Extract<RightPanelSurface, { kind: K }>, names: TabNames): string;
  /** The glyph a tab draws where it is not the pane's own: a file tab in the files pane. */
  tabIcon?(surface: Extract<RightPanelSurface, { kind: K }>): LucideIcon;
  /** Open on this computer's own panel, the pane reads this computer's daemon link. */
  readsHere?: true;
}

const NO_PROJECT_HERE = "Pick a project to review its changes.";
const running = (at: PaneContext): boolean => at.workspace?.phase === "running";
const computerSilent = (at: PaneContext): string | undefined => (at.here ? undefined : at.absent?.sentence);

export const PANES: { readonly [K in RightPanelKind]: Pane<K> } = {
  preview: {
    label: "Browser",
    description: "Open your dev server or a URL.",
    icon: Globe2,
    shortcut: "B",
    hint: "Available while this runs.",
    available: at => at.here || running(at),
    title: (surface, names) => {
      const snapshot = surface.resourceId ? names.previewSessions[surface.resourceId] : null;
      if (!snapshot || !snapshot.url) return "Browser";
      if (snapshot.title.trim().length > 0) return snapshot.title;
      try {
        return new URL(snapshot.url).host || "Browser";
      } catch {
        return "Browser";
      }
    },
  },
  terminal: {
    label: "Terminal",
    description: "Start a shell here.",
    icon: TerminalSquare,
    shortcut: "T",
    hint: "Available while this runs.",
    available: at => at.here || (running(at) && at.absent === null),
    // A panel terminal cannot open at all without a pty, so its card keeps the computer's own sentence.
    reason: computerSilent,
    title: (surface, names) => names.terminalLabelsById.get(surface.activeTerminalId) ?? "Terminal",
  },
  diff: {
    label: "Changes",
    description: "Review the changes here.",
    icon: FileDiff,
    shortcut: "D",
    hint: "Review the changes once it runs.",
    available: running,
    reason: at => (at.here ? NO_PROJECT_HERE : undefined),
  },
  files: {
    label: "Files",
    description: "Browse and read the files here.",
    icon: Folder,
    shortcut: "F",
    hint: "Available while this runs.",
    available: running,
    reason: at => (at.here ? "Pick a thread to read its files." : undefined),
    title: surface => (surface.path === null ? "Files" : baseName(surface.path)),
    tabIcon: surface => (surface.path === null ? Folder : File),
  },
  machine: {
    label: "Computer",
    description: "Load, memory and disk.",
    icon: Cpu,
    shortcut: "M",
    hint: "Pick a thread to use it.",
    available: at => at.here || at.workspace !== null,
    readsHere: true,
  },
  processes: {
    label: "Processes",
    description: "Inspect and kill what runs.",
    icon: Activity,
    shortcut: "P",
    hint: "Available while this runs.",
    // The pane carries the start button itself where this host can put the daemon back.
    available: at => at.here || (running(at) && (at.absent === null || at.absent.start !== undefined)),
    reason: computerSilent,
    readsHere: true,
  },
  agents: {
    label: "Agents",
    description: "Agents, skills and servers here.",
    icon: Bot,
    shortcut: "A",
    hint: "Pick a thread to use it.",
    // A paused workspace answers its last report and is never woken for it.
    available: at => at.workspace !== null,
  },
};

export const PANE_KINDS = Object.keys(PANES) as RightPanelKind[];

export const paneOf = (kind: RightPanelKind): Pane => PANES[kind] as Pane;

export function paneTitle(surface: RightPanelSurface, names: TabNames): string {
  return paneOf(surface.kind).title?.(surface, names) ?? paneOf(surface.kind).label;
}
