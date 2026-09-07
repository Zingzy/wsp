// SPDX-License-Identifier: AGPL-3.0-only
// One card per workspace, built from the same snapshot the sidebar draws: its
// order, its state word and its top thread. Nothing here decides an order or
// a word of its own.
import type { SidebarProjectSnapshot } from "../../adapt/index.js";
import type { CostTick } from "../../protocol/store.js";
import type { WorkspaceLine } from "../../shell/workspacePreviews.js";
import { topSidebarThread } from "../../sidebar/Sidebar.logic.js";
import { accruedTodayLabel } from "../../sidebar/workspaceRows.js";

export interface SwitcherCard {
  readonly workspaceId: string;
  readonly name: string;
  /** The word the sidebar's indicator carries, which is the workspace-state table's. */
  readonly stateWord: string;
  readonly costToday: string | null;
  readonly threadTitle: string | null;
  /** The last line of that thread as the chat last drew it; absent until this workspace has been open here. */
  readonly lastLine: string | null;
  /** A picture of the page as the shell last took it; absent in a browser tab, which cannot take one. */
  readonly image: string | null;
  /** The workspace the person is on, which the overlay marks apart from the highlight. */
  readonly current: boolean;
}

export interface SwitcherCardsInput {
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  /** The ids the overlay froze when it opened; a workspace that has since gone leaves no card. */
  readonly ids: ReadonlyArray<string>;
  readonly costs: Readonly<Record<string, CostTick>>;
  readonly lines: Readonly<Record<string, WorkspaceLine>>;
  readonly images: Readonly<Record<string, string>>;
  readonly currentId: string | null;
  /** The thread pinned in the sidebar, which belongs to the current workspace alone. */
  readonly pinnedThreadId: string | null;
}

export function buildSwitcherCards(input: SwitcherCardsInput): SwitcherCard[] {
  const byId = new Map(input.projects.map(project => [project.id, project]));
  return input.ids.flatMap(workspaceId => {
    const project = byId.get(workspaceId);
    if (project === undefined) return [];
    const current = workspaceId === input.currentId;
    const pinned = current && input.pinnedThreadId !== null ? project.threads.find(t => t.id === input.pinnedThreadId) : undefined;
    const thread = pinned ?? topSidebarThread(project.threads);
    const line = input.lines[workspaceId];
    return [
      {
        workspaceId,
        name: project.displayName,
        stateWord: project.indicator.label,
        costToday: accruedTodayLabel(input.costs[workspaceId]?.accruedUsd ?? null),
        threadTitle: thread?.title ?? null,
        lastLine: thread !== null && line?.threadKey === thread.id ? line.text : null,
        image: input.images[workspaceId] ?? null,
        current,
      },
    ];
  });
}
