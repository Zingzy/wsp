// SPDX-License-Identifier: AGPL-3.0-only
// One card per workspace, built from the same snapshot the sidebar draws: its
// order and its top thread. Nothing here decides an order or a thread of its
// own.
import type { SidebarProjectSnapshot } from "../../adapt/index.js";
import { topSidebarThread } from "../../sidebar/Sidebar.logic.js";

export interface SwitcherCard {
  readonly workspaceId: string;
  readonly name: string;
  readonly threadTitle: string | null;
  /** A picture of the page as the shell last took it; absent in a browser tab, which cannot take one. */
  readonly image: string | null;
}

export interface SwitcherCardsInput {
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  /** The ids the overlay froze when it opened; a workspace that has since gone leaves no card. */
  readonly ids: ReadonlyArray<string>;
  readonly images: Readonly<Record<string, string>>;
  /** The workspace the person is on, whose card names the thread the sidebar pins rather than its top one. */
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
    return [
      {
        workspaceId,
        name: project.displayName,
        threadTitle: thread?.title ?? null,
        image: input.images[workspaceId] ?? null,
      },
    ];
  });
}
